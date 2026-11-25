#!/usr/bin/env node
// ADR 0048: coxswain's view tools for a Claude Code session in a terminal, as a stdio MCP server. Register it once:
//   claude mcp add -s user coxswain -- node <this file>
// It lists the tools from <userData>/terminal-tools.json, and only inside a repository coxswain has as a local
// repository, so sessions elsewhere get none. The first tool call connects to <userData>/control.sock with the
// session's directory; the app opens that branch's workspace, or the one use_workspace picked, and answers each call.
// No app running: the call says so.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const userData =
  process.env.COXSWAIN_USER_DATA ?? join(homedir(), "Library", "Application Support", "coxswain");
const catalogFile = "terminal-tools.json";
const cwd = process.cwd();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// ADR 0049: how coxswain's messages reach this session, picked once now. A channel only when Claude Code was started
// with this server named in --channels or --dangerously-load-development-channels (an organization's policy may still
// drop its events, and nothing here can tell); else the session's inbox socket; else none.
// The name this server is registered under: `coxswain`, or COXSWAIN_MCP_NAME for another (a dev run's).
const serverName = process.env.COXSWAIN_MCP_NAME || "coxswain";
const account = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
function pickRoute() {
  let args = [];
  try {
    args = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/[\s,]+/);
  } catch {}
  const flagged = args.some(
    (a) => a === "--channels" || a === "--dangerously-load-development-channels",
  );
  const named = args.some(
    (a) => a === `server:${serverName}` || a.startsWith(`plugin:${serverName}@`),
  );
  if (flagged && named) return "channel";
  return process.env.CLAUDE_CODE_MESSAGING_SOCKET ? "inbox" : "none";
}
const route = pickRoute();

const pushInstructions =
  route === "channel"
    ? [
        "coxswain, the review app the user reads code in, may send you messages as <channel> events from this server.",
        "Each one is the user asking something of you from coxswain, for example to review lines they selected or to take",
        "the replies waiting on your findings. Act on it as you would on the user's own message. When it names a thread, a",
        "file or lines, answer in coxswain with its tools (reply_to_thread, add_finding); otherwise answer here.",
      ].join(" ")
    : [
        "coxswain, the review app the user reads code in, may send you a message that starts 'From coxswain, sent by the",
        "user'. It arrives as a message from another session, because that's the way in coxswain has; it is a request the",
        "user made in coxswain, for example to review lines they selected or to take the replies waiting on your findings.",
        "When it names a thread, a file or lines, answer in coxswain with its tools (reply_to_thread, add_finding).",
      ].join(" ");
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// The repository the session runs in, by its main checkout (the folder holding the common .git).
let repo = null;
try {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  repo = real(dirname(common.trim()));
} catch {}

function listed() {
  try {
    const catalog = JSON.parse(readFileSync(join(userData, catalogFile), "utf8"));
    return repo && catalog.projects.some((p) => real(p) === repo) ? catalog.tools : [];
  } catch {
    return null; // none yet, or half written
  }
}

// One connection per session, opened by the first call, again after the app went away, and by use_workspace.
let connection = null;
let nextId = 1;
// use_workspace's pick, { branch } or { pr }, sent on every connection so it outlasts an app restart. Empty: the branch
// checked out in cwd.
let pick = {};
// set_session_name's arguments, said again on each new connection: the app keeps the name per connection.
let named = null;

// Both are kept per Claude Code session in <userData>/terminal-sessions/<id>.json, so a new bridge for the same session
// (/mcp reconnect, a resumed session) carries on with them instead of starting over in cwd's branch, unnamed.
// ponytail: the files are never removed; they're a few bytes each. Prune by age if the folder ever matters.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
const stateFile =
  sessionId && /^[\w-]+$/.test(sessionId)
    ? join(userData, "terminal-sessions", `${sessionId}.json`)
    : null;
try {
  if (stateFile) ({ pick = {}, named = null } = JSON.parse(readFileSync(stateFile, "utf8")));
} catch {} // none yet
function saveState() {
  if (!stateFile) return;
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ pick, named }));
  } catch {}
}

function open() {
  const opening = new Promise((resolve, reject) => {
    const socket = connect(join(userData, "control.sock"));
    const pending = new Map();
    let ready = false;
    const fail = (error) => {
      if (connection === opening) connection = null; // not one use_workspace opened since
      if (!ready) reject(error);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    };
    socket.on("error", (e) =>
      fail(
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? new Error("coxswain isn't running. Start it, then call the tool again.")
          : e,
      ),
    );
    socket.on("close", () =>
      fail(new Error("coxswain closed the connection. Call the tool again.")),
    );
    socket.on("connect", () => socket.write(`mcp ${JSON.stringify({ cwd, ...pick })}\n`));
    // readline repeats the socket's errors; the socket's own handler deals with them.
    const lines = createInterface({ input: socket }).on("error", () => {});
    lines.on("line", (line) => {
      if (!ready) {
        if (!line.startsWith("ready "))
          return fail(new Error(line.replace(/^error: /, "coxswain: ")));
        ready = true;
        if (named) {
          const id = nextId++;
          pending.set(id, { resolve: () => {}, reject: () => {} });
          const params = { name: "set_session_name", arguments: named };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`);
        }
        return resolve({ socket, pending, label: line.slice("ready ".length) });
      }
      const reply = JSON.parse(line);
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    });
  });
  return opening;
}

const answer = (id, text, isError = false) => ({
  jsonrpc: "2.0",
  id,
  result: { isError, content: [{ type: "text", text }] },
});

// use_workspace: connect again with the new pick; if coxswain refuses it, the old pick stays.
async function useWorkspace(message) {
  const { branch, pr } = message.params?.arguments ?? {};
  if (branch !== undefined && pr !== undefined)
    return answer(message.id, "Give branch or pr, not both.", true);
  if (branch !== undefined && (typeof branch !== "string" || !branch.trim()))
    return answer(message.id, "branch must be a branch name.", true);
  if (pr !== undefined && !Number.isInteger(pr))
    return answer(message.id, "pr must be a PR number.", true);
  const before = pick;
  const old = connection;
  pick = branch !== undefined ? { branch: branch.trim() } : pr !== undefined ? { pr } : {};
  try {
    connection = open();
    const { label } = await connection;
    saveState();
    old?.then(
      ({ socket }) => socket.destroy(),
      () => {},
    );
    return answer(
      message.id,
      `coxswain now works on ${label}. Every coxswain tool uses this workspace until you call use_workspace again.`,
    );
  } catch (e) {
    pick = before;
    connection = old;
    return answer(message.id, e.message, true);
  }
}

async function call(message) {
  try {
    connection ??= open();
    const { socket, pending } = await connection;
    const id = nextId++;
    const reply = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ ...message, id })}\n`);
    });
    if (message.params?.name === "set_session_name" && !reply.result?.isError) {
      named = message.params.arguments;
      saveState();
      listener?.write(`${JSON.stringify({ name: named.name })}\n`);
    }
    // The app closes the connection; a pick kept would open the removed workspace again.
    if (message.params?.name === "remove_workspace" && !reply.result?.isError) {
      pick = {};
      connection = null;
      saveState();
    }
    return { ...reply, id: message.id };
  } catch (e) {
    // No connection: the name is kept for the next one, which use_workspace may open.
    const name = message.params?.arguments?.name;
    if (message.params?.name !== "set_session_name" || typeof name !== "string" || !name.trim())
      return answer(message.id, e.message, true);
    named = message.params.arguments;
    saveState();
    return answer(
      message.id,
      `${e.message}\nThe name is kept: coxswain gets it once it connects.`,
      true,
    );
  }
}

// ADR 0049: a connection kept open from the start, which tells coxswain this session is here and on which coxswain
// pushes messages to it (src/core/terminal-sessions.ts). The ack says Claude Code has the message, not that it was read.
// While coxswain isn't there, it tries again after 1 s, then 2, 4, 8 and every 10 s.
const protocol = 1;
let listener = null;
let initialized = false; // listen() keeps itself going from the first initialize on

// The session's name as Claude Code keeps it (ListAgents' name), when it hasn't named itself with set_session_name.
// ponytail: <config>/sessions/<pid>.json isn't documented; read once per connection, and nothing breaks without it.
function registryName() {
  try {
    const entry = JSON.parse(
      readFileSync(join(account, "sessions", `${process.ppid}.json`), "utf8"),
    );
    return typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
  } catch {
    return null;
  }
}

function listen(wait = 1000) {
  if (!sessionId) return;
  const socket = connect(join(userData, "control.sock"));
  let answered = false;
  let replaced = false;
  socket.on("error", () => {});
  socket.on("close", () => {
    if (listener === socket) listener = null;
    if (replaced) return; // another bridge for this session took over
    const next = answered ? 1000 : Math.min(wait * 2, 10000);
    setTimeout(() => listen(next), next).unref();
  });
  socket.on("connect", () => {
    const hello = {
      protocol,
      session: sessionId,
      name: named?.name ?? registryName(),
      cwd,
      account,
      route,
    };
    socket.write(`session ${JSON.stringify(hello)}\n`);
  });
  createInterface({ input: socket })
    .on("error", () => {})
    .on("line", (line) => {
      if (!answered) {
        // "outdated": this coxswain speaks another protocol. Stay connected, so the session is listed as one to
        // restart, and take no pushes.
        if (line !== "ready" && !line.startsWith("outdated")) return socket.destroy();
        answered = true;
        if (line === "ready") listener = socket;
        return;
      }
      if (listener !== socket && line !== "replaced") return;
      if (line === "replaced") return void (replaced = true);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg.push) return;
      const { id, text, meta } = msg.push;
      deliver(id, text, meta ?? {}).then(
        () => socket.write(`${JSON.stringify({ ack: id })}\n`),
        (e) => socket.write(`${JSON.stringify({ nack: id, error: e.message })}\n`),
      );
    });
}

// Into the session by its route: a channel event, or a message on the session's own inbox socket, which every
// interactive session since v2.1.224 has. The session reads it between tool calls, or starts a turn with it when idle,
// shown as a message from another session.
// ponytail: the socket's frame ({"type":"user",…} after the documented auth line) is from Claude Code's own example,
// not its docs. Upgrade: the documented frame, once there is one.
function deliver(id, text, meta) {
  if (route === "channel") {
    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: text, meta: { ...meta, push_id: String(id) } },
    });
    return Promise.resolve();
  }
  const inbox = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!inbox)
    return Promise.reject(
      new Error("the session has no inbox socket (Claude Code before v2.1.224?)"),
    );
  const about = Object.entries(meta)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const content = `From coxswain, sent by the user${about ? ` (${about})` : ""}:\n${text}`;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  return new Promise((done, fail) => {
    const s = connect(inbox, () => {
      if (token) s.write(`${JSON.stringify({ type: "auth", token })}\n`);
      s.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`, done);
    });
    s.on("error", fail);
  });
}

// The app rewrites the catalog when it starts or adds a repository: tell the session its tools may have changed.
let shown = null;
try {
  watch(userData, (_, file) => {
    if (file !== catalogFile || shown === null) return;
    const tools = listed();
    const now = JSON.stringify(tools);
    if (!tools || now === shown) return;
    shown = now;
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });
} catch {}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // a notification
  const result = (r) => send({ jsonrpc: "2.0", id: message.id, result: r });
  switch (message.method) {
    case "initialize": {
      // Claude Code doesn't take a server on MCP revision 2026-07-28 or later as a channel: stay on an earlier one.
      const asked = message.params?.protocolVersion;
      if (!initialized) {
        initialized = true;
        listen();
      }
      return result({
        protocolVersion: typeof asked === "string" && asked < "2025-06-18" ? asked : "2025-06-18",
        capabilities: {
          tools: { listChanged: true },
          ...(route === "channel" ? { experimental: { "claude/channel": {} } } : {}),
        },
        serverInfo: { name: "coxswain", version: "0" },
        instructions: pushInstructions,
      });
    }
    case "ping":
      return result({});
    case "tools/list": {
      const tools = listed() ?? [];
      shown = JSON.stringify(tools);
      return result({ tools });
    }
    case "tools/call":
      return send(
        await (message.params?.name === "use_workspace" ? useWorkspace(message) : call(message)),
      );
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `No method ${message.method}` },
      });
  }
});
process.stdin.on("end", () => process.exit(0));
