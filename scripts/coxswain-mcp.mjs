#!/usr/bin/env node
// ADR 0048: coxswain's view tools for a Claude Code session in a terminal, as a stdio MCP server. Register it once:
//   claude mcp add -s user coxswain -- node <this file>
// It lists the tools from <userData>/terminal-tools.json, and only inside a repository coxswain has as a local
// repository, so sessions elsewhere get none. The first tool call connects to <userData>/control.sock with the
// session's directory; the app opens that branch's workspace and answers each call. No app running: the call says so.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, watch } from "node:fs";
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

// One connection per session, opened by the first call and again after the app went away.
let connection = null;
let nextId = 1;

function open() {
  return new Promise((resolve, reject) => {
    const socket = connect(join(userData, "control.sock"));
    const pending = new Map();
    let ready = false;
    const fail = (error) => {
      connection = null;
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
    socket.on("connect", () => socket.write(`mcp ${JSON.stringify({ cwd })}\n`));
    // readline repeats the socket's errors; the socket's own handler deals with them.
    const lines = createInterface({ input: socket }).on("error", () => {});
    lines.on("line", (line) => {
      if (!ready) {
        if (!line.startsWith("ready "))
          return fail(new Error(line.replace(/^error: /, "coxswain: ")));
        ready = true;
        return resolve({ socket, pending });
      }
      const reply = JSON.parse(line);
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    });
  });
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
    return { ...reply, id: message.id };
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: true, content: [{ type: "text", text: e.message }] },
    };
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
      return send(await call(message));
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `No method ${message.method}` },
      });
  }
});
process.stdin.on("end", () => process.exit(0));
