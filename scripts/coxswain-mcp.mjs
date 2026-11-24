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
    case "initialize":
      return result({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "coxswain", version: "0" },
      });
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
