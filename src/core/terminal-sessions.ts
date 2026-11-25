import type { Socket } from "node:net";
import type { Interface } from "node:readline";

// Spike for terminal comms v2 (ADR 0048 is the pull-only bridge it would extend): the terminal sessions connected to
// coxswain right now, and coxswain pushing a message to one of them.
//
// A session's bridge (scripts/coxswain-mcp.mjs) keeps one connection open from when it starts, begun with the line
// `session {"session": <Claude Code session id>, "name": <its name, if set>, "cwd": …}`. coxswain answers `ready`,
// then writes one JSON object per line, `{"push": {"id", "text", "meta"}}`, and the bridge answers `{"ack": id}` once it
// has handed the message to the session. The bridge may also send `{"name": …}` when the session names itself.
//
// ponytail: a module-level map in the core, no event for the UI and nothing stored; presence is only what this process
// has seen since it started. Upgrade path is the comms v2 ADR: sessions as core state with an emit, shown in the UI.

export type TerminalSession = { session: string; name: string | null; cwd: string; since: Date };

type Live = TerminalSession & { socket: Socket; acks: Map<number, (error: string | null) => void> };

const live = new Map<string, Live>();
let nextPush = 1;

export function connectedSessions(): TerminalSession[] {
  return [...live.values()].map(({ session, name, cwd, since }) => ({ session, name, cwd, since }));
}

export function serveSession(socket: Socket, lines: Interface, hello: string) {
  let said: { session?: unknown; name?: unknown; cwd?: unknown };
  try {
    said = JSON.parse(hello);
  } catch {
    said = {};
  }
  if (typeof said.session !== "string" || !said.session || typeof said.cwd !== "string") {
    lines.close();
    return void socket.end('error: say who and where: session {"session": …, "cwd": …}\n');
  }
  // A new bridge for the same session (an /mcp reconnect, a resumed session) replaces the old connection; "replaced"
  // tells the old bridge not to connect again, so two of them don't take turns.
  live.get(said.session)?.socket.end("replaced\n");
  const entry: Live = {
    session: said.session,
    name: typeof said.name === "string" && said.name.trim() ? said.name.trim() : null,
    cwd: said.cwd,
    since: new Date(),
    socket,
    acks: new Map(),
  };
  live.set(entry.session, entry);
  socket.write("ready\n");
  lines.on("line", (line) => {
    let msg: { ack?: unknown; nack?: unknown; error?: unknown; name?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id =
      typeof msg.ack === "number" ? msg.ack : typeof msg.nack === "number" ? msg.nack : null;
    if (id !== null) {
      entry.acks.get(id)?.(typeof msg.nack === "number" ? String(msg.error ?? "refused") : null);
      entry.acks.delete(id);
    }
    if (typeof msg.name === "string" && msg.name.trim()) entry.name = msg.name.trim();
  });
  socket.on("close", () => {
    if (live.get(entry.session) === entry) live.delete(entry.session);
  });
  socket.on("end", () => socket.end());
}

// A control socket line `push {"to": <session name or id>, "text": …, "meta"?: {…}}`: the answer once the session's
// bridge has it, or why not.
export async function pushToSession(said: string, timeoutMs = 5000): Promise<string> {
  let to: unknown, text: unknown, meta: unknown;
  try {
    ({ to, text, meta } = JSON.parse(said));
  } catch {
    throw new Error('say whom and what: push {"to": …, "text": …}');
  }
  if (typeof to !== "string" || typeof text !== "string" || !text)
    throw new Error('say whom and what: push {"to": …, "text": …}');
  const found = [...live.values()].filter((s) => s.session === to || s.name === to);
  if (found.length === 0) throw new Error(`no session ${to} is connected; ${sessionList()}`);
  if (found.length > 1)
    throw new Error(`${found.length} sessions are named ${to}: say which by id`);
  const target = found[0];
  const id = nextPush++;
  const clean = meta && typeof meta === "object" ? stringMeta(meta as Record<string, unknown>) : {};
  const who = target.name ?? target.session;
  // null: the bridge handed it on; a string: why it couldn't.
  const acked = new Promise<string | null>((done) => {
    const timer = setTimeout(
      () => done(`${who} didn't take it within ${timeoutMs / 1000}s`),
      timeoutMs,
    );
    target.acks.set(id, (error) => {
      clearTimeout(timer);
      done(error === null ? null : `${who} couldn't take it: ${error}`);
    });
  });
  target.socket.write(`${JSON.stringify({ push: { id, text, meta: clean } })}\n`);
  const error = await acked;
  target.acks.delete(id);
  if (error !== null) throw new Error(error);
  return `delivered to ${who}`;
}

// The channel drops meta keys that aren't identifiers, and takes only string values.
function stringMeta(meta: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([k, v]) => /^\w+$/.test(k) && v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
}

export function sessionList(): string {
  const all = connectedSessions();
  if (all.length === 0) return "no sessions are connected";
  return `connected: ${all.map((s) => `${s.name ?? "(unnamed)"} ${s.session} in ${s.cwd}`).join("; ")}`;
}
