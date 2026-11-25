import { homedir } from "node:os";
import type { Socket } from "node:net";
import type { Interface } from "node:readline";
import { emit } from "./events.ts";

// ADR 0049: the terminal sessions connected to coxswain now, and coxswain pushing a message to one of them.
//
// A session's bridge (scripts/coxswain-mcp.mjs) keeps one connection open from when it starts, begun with the line
// `session {"protocol", "session", "name", "cwd", "account", "route"}`. coxswain answers `ready`, then writes one JSON
// object per line, `{"push": {"id", "text", "meta"}}`, and the bridge answers `{"ack": id}` once Claude Code has the
// message, or `{"nack": id, "error"}`. The bridge also sends `{"name": …}` when the session names itself. A bridge on
// another protocol is answered `outdated` instead, and stays listed, with pushes refused, until its session ends.
//
// Held in memory only: who is connected now. Every change emits "terminal-sessions".

export const terminalProtocol = 1;

export type TerminalRoute = "channel" | "inbox" | "none";
export type TerminalSession = {
  session: string;
  name: string | null;
  cwd: string;
  // The Claude Code config folder it runs under: one coxswain serves sessions of several Claude accounts.
  account: string;
  route: TerminalRoute;
  // Its bridge speaks another protocol than this coxswain: restart the session to connect.
  outdated: boolean;
  since: Date;
};
export type TerminalSessions = {
  sessions: TerminalSession[];
  // coxswain started moments ago: bridges are still coming back (they retry every 1–10 s).
  settling: boolean;
};

type Live = TerminalSession & {
  socket: Socket;
  acks: Map<number, (error: string | null) => void>;
};

const live = new Map<string, Live>();
const startedAt = Date.now();
const settleMs = 12_000;
let nextPush = 1;

export function listTerminalSessions(): TerminalSessions {
  return {
    sessions: [...live.values()].map(({ session, name, cwd, account, route, outdated, since }) => ({
      session,
      name,
      cwd,
      account,
      route,
      outdated,
      since,
    })),
    settling: Date.now() - startedAt < settleMs,
  };
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function serveSession(socket: Socket, lines: Interface, hello: string) {
  let said: Record<string, unknown>;
  try {
    said = JSON.parse(hello);
  } catch {
    said = {};
  }
  if (typeof said.session !== "string" || !said.session || typeof said.cwd !== "string") {
    lines.close();
    return void socket.end('error: say who and where: session {"session": …, "cwd": …}\n');
  }
  const outdated = said.protocol !== terminalProtocol;
  // A new bridge for the same session (an /mcp reconnect, a resumed session) replaces the old connection; "replaced"
  // tells the old bridge not to connect again, so two of them don't take turns.
  const before = live.get(said.session);
  if (before) {
    live.delete(said.session);
    before.socket.end("replaced\n");
  }
  const entry: Live = {
    session: said.session,
    name: text(said.name),
    cwd: said.cwd,
    account: text(said.account) ?? `${homedir()}/.claude`,
    route: said.route === "channel" || said.route === "inbox" ? said.route : "none",
    outdated,
    since: new Date(),
    socket,
    acks: new Map(),
  };
  live.set(entry.session, entry);
  emit({ what: "terminal-sessions" });
  socket.write(outdated ? "outdated: restart this session to connect to coxswain\n" : "ready\n");
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
    const name = text(msg.name);
    if (name && name !== entry.name) {
      entry.name = name;
      emit({ what: "terminal-sessions" });
    }
  });
  socket.on("close", () => {
    for (const done of entry.acks.values()) done("its connection closed");
    if (live.get(entry.session) !== entry) return;
    live.delete(entry.session);
    emit({ what: "terminal-sessions" });
  });
  socket.on("end", () => socket.end());
}

// Pushes `text` to the connected session `to` (its id, or a name only one connected session has), with `meta` (what
// it's about: file, lines, thread) attached. Resolves once the session's Claude Code has it; rejects with why not.
export async function pushToSession(
  to: string,
  text: string,
  meta: Record<string, unknown> = {},
  timeoutMs = 5000,
): Promise<string> {
  if (!text) throw new Error("nothing to send");
  const byId = live.get(to);
  const found = byId ? [byId] : [...live.values()].filter((s) => s.name === to);
  if (found.length === 0) throw new Error(`no session ${to} is connected; ${sessionList()}`);
  if (found.length > 1)
    throw new Error(
      `${found.length} sessions are named ${to} (${found.map((s) => `${s.session} in ${s.account}`).join(", ")}): say which by id`,
    );
  const target = found[0];
  const who = target.name ?? target.session;
  if (target.outdated)
    throw new Error(`${who} runs an older coxswain bridge: restart that session to connect`);
  if (target.route === "none")
    throw new Error(
      `${who} can't take messages: its Claude Code has no inbox (before v2.1.224?) and no channel`,
    );
  const id = nextPush++;
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
  target.socket.write(`${JSON.stringify({ push: { id, text, meta: stringMeta(meta) } })}\n`);
  const error = await acked;
  target.acks.delete(id);
  if (error !== null) throw new Error(error);
  return `delivered to ${who}`;
}

// A control socket line `push {"to": <session id or name>, "text": …, "meta"?: {…}}`.
export function pushLine(said: string): Promise<string> {
  let to: unknown, body: unknown, meta: unknown;
  try {
    ({ to, text: body, meta } = JSON.parse(said));
  } catch {}
  if (typeof to !== "string" || typeof body !== "string" || !body)
    return Promise.reject(new Error('say whom and what: push {"to": …, "text": …}'));
  return pushToSession(
    to,
    body,
    meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {},
  );
}

// A channel drops meta keys that aren't identifiers, and takes only string values.
function stringMeta(meta: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([k, v]) => /^\w+$/.test(k) && v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
}

// The control socket's `sessions` line.
export function sessionList(): string {
  const { sessions, settling } = listTerminalSessions();
  if (sessions.length === 0)
    return settling ? "no sessions are connected yet" : "no sessions are connected";
  const one = (s: TerminalSession) =>
    `${s.name ?? "(unnamed)"} ${s.session} in ${s.cwd} [${s.outdated ? "outdated" : s.route}, ${s.account}]`;
  return `connected: ${sessions.map(one).join("; ")}`;
}
