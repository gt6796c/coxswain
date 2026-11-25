import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { openDatabase } from "./db.ts";
import { onEvent } from "./events.ts";
import { startControl } from "./open-target.ts";
import { listTerminalSessions } from "./terminal-sessions.ts";

// ADR 0049: terminal sessions connect to coxswain through their bridge, and coxswain pushes a message to one.
const temp = realpathSync(mkdtempSync(join(os.tmpdir(), "cx-sessions-")));
after(() => rmSync(temp, { recursive: true, force: true }));
const bridgeScript = join(import.meta.dirname, "../../scripts/coxswain-mcp.mjs");

const say = (sock: string, line: string) =>
  new Promise<string>((done, fail) => {
    const socket = connect(sock, () => socket.write(`${line}\n`));
    createInterface({ input: socket }).once("line", (answer) => {
      socket.destroy();
      done(answer);
    });
    socket.on("error", fail);
  });

// The bridge as Claude Code starts it, collecting what it writes to the session. With `channel`, its parent's command
// line names it in --dangerously-load-development-channels, as Claude Code's would.
// Without an inbox unless given one: these tests may run inside a Claude Code session, whose own inbox must not get pushes.
function bridge(
  userData: string,
  sessionId: string,
  { env = {}, channel = false }: { env?: Record<string, string>; channel?: boolean } = {},
) {
  const parentArgs = channel
    ? [
        "-e",
        "const c = require('child_process').spawn(process.execPath, [process.argv[1]], { stdio: 'inherit' }); c.on('exit', (code) => process.exit(code ?? 0));",
        bridgeScript,
        "--dangerously-load-development-channels",
        "server:coxswain",
      ]
    : [bridgeScript];
  const child = spawn(process.execPath, parentArgs, {
    cwd: temp,
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
      CLAUDE_CONFIG_DIR: join(temp, "account"),
      COXSWAIN_MCP_NAME: "",
      COXSWAIN_USER_DATA: userData,
      CLAUDE_CODE_SESSION_ID: sessionId,
      ...env,
    },
  });
  child.stderr.pipe(process.stderr);
  const out: Record<string, unknown>[] = [];
  const seen: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    out.push(JSON.parse(line));
    for (const s of seen.splice(0)) s();
  });
  const next = (pred: (m: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((done) => {
      const look = () => {
        const m = out.find(pred);
        if (m) done(m);
        else seen.push(look);
      };
      look();
    });
  const send = (msg: object) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const stop = () => {
    child.stdin.end();
    child.kill();
  };
  return { child, next, send, stop };
}

// A bridge's hello written by hand: the first line coxswain answers, and the open connection.
function hello(sock: string, said: object) {
  const socket: Socket = connect(sock, () => socket.write(`session ${JSON.stringify(said)}\n`));
  const first = new Promise<string>((done) =>
    createInterface({ input: socket }).once("line", done),
  );
  socket.on("error", () => {});
  return { socket, first };
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("timed out");
};

async function control(t: { after: (fn: () => void) => void }, dir: string) {
  const userData = join(temp, dir);
  mkdirSync(userData, { recursive: true });
  const db = openDatabase(join(temp, `${dir}.db`));
  t.after(() => db.destroy());
  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  return { userData, sock: join(userData, "control.sock") };
}

test("a session started with the channel flag gets pushes as channel events", async (t) => {
  const { userData, sock } = await control(t, "d1");
  const b = bridge(userData, "session-1", { channel: true });
  t.after(b.stop);
  b.send({ id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
  const init = (await b.next((m) => m.id === 1)).result as Record<string, unknown>;
  // A channel on the newest MCP revision isn't taken as one.
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual((init.capabilities as { experimental: object }).experimental, {
    "claude/channel": {},
  });
  assert.match(String(init.instructions), /<channel> events/);

  await until(async () => (await say(sock, "sessions")).includes("session-1"));
  assert.match(
    await say(sock, "sessions"),
    new RegExp(`\\(unnamed\\) session-1 in ${temp} \\[channel, ${temp}/account\\]`),
  );

  const pushed = await say(
    sock,
    `push ${JSON.stringify({ to: "session-1", text: "Review lines 3-9 of a.ts", meta: { file: "a.ts", "bad-key": "x" } })}`,
  );
  assert.equal(pushed, "delivered to session-1");
  const event = await b.next((m) => m.method === "notifications/claude/channel");
  assert.deepEqual((event.params as { content: string }).content, "Review lines 3-9 of a.ts");
  assert.deepEqual((event.params as { meta: object }).meta, {
    file: "a.ts",
    push_id: (event.params as { meta: { push_id: string } }).meta.push_id,
  });

  assert.match(
    await say(sock, `push ${JSON.stringify({ to: "nobody", text: "hi" })}`),
    /^error: no session nobody is connected; connected: .*session-1/,
  );
  assert.match(await say(sock, "push {}"), /^error: say whom and what/);
});

test("a session's bridge connects again when coxswain comes back", async (t) => {
  const userData = join(temp, "d2");
  mkdirSync(userData, { recursive: true });
  const db = openDatabase(join(temp, "d2.db"));
  t.after(() => db.destroy());
  const sock = join(userData, "control.sock");

  // The bridge starts before the app.
  const b = bridge(userData, "session-2");
  t.after(b.stop);
  b.send({ id: 1, method: "initialize", params: {} });
  await b.next((m) => m.id === 1);

  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  await until(async () => (await say(sock, "sessions")).includes("session-2"));
});

test("without the flag a push goes into the session's own inbox socket, as a message from coxswain", async (t) => {
  const { userData, sock } = await control(t, "d3");

  // The session's inbox, as Claude Code binds it: one connection per message, JSON lines.
  const inboxPath = join(temp, "in.sock");
  const received: string[][] = [];
  const inbox = createServer((c) => {
    const lines: string[] = [];
    createInterface({ input: c }).on("line", (l) => lines.push(l));
    c.on("end", () => received.push(lines));
  });
  await new Promise<void>((done) => inbox.listen(inboxPath, done));
  t.after(() => inbox.close());

  const b = bridge(userData, "session-3", {
    env: { CLAUDE_CODE_MESSAGING_SOCKET: inboxPath, CLAUDE_CODE_MESSAGING_TOKEN: "tok" },
  });
  t.after(b.stop);
  b.send({ id: 1, method: "initialize", params: {} });
  const init = (await b.next((m) => m.id === 1)).result as Record<string, unknown>;
  assert.equal((init.capabilities as { experimental?: object }).experimental, undefined);
  assert.match(String(init.instructions), /starts 'From coxswain, sent by the/);
  await until(() => listTerminalSessions().sessions.some((s) => s.session === "session-3"));
  assert.equal(
    listTerminalSessions().sessions.find((s) => s.session === "session-3")?.route,
    "inbox",
  );

  const push = { to: "session-3", text: "Review a.ts:3-9", meta: { file: "a.ts" } };
  assert.equal(await say(sock, `push ${JSON.stringify(push)}`), "delivered to session-3");
  await until(() => received.length === 1);
  assert.deepEqual(
    received[0].map((l) => JSON.parse(l)),
    [
      { type: "auth", token: "tok" },
      {
        type: "user",
        message: {
          role: "user",
          content: "From coxswain, sent by the user (file=a.ts):\nReview a.ts:3-9",
        },
      },
    ],
  );

  // A session with neither is listed, and a push to it is refused at once with why.
  const none = bridge(userData, "session-4");
  t.after(none.stop);
  none.send({ id: 1, method: "initialize", params: {} });
  await none.next((m) => m.id === 1);
  await until(() => listTerminalSessions().sessions.some((s) => s.session === "session-4"));
  assert.match(
    await say(sock, `push ${JSON.stringify({ to: "session-4", text: "hi" })}`),
    /^error: session-4 can't take messages: its Claude Code has no inbox/,
  );
});

test("a session unnamed by set_session_name is listed by the name Claude Code keeps for it", async (t) => {
  const { userData } = await control(t, "d4");
  // The bridge's parent is this test process; its Claude Code would have written this.
  mkdirSync(join(temp, "account", "sessions"), { recursive: true });
  writeFileSync(
    join(temp, "account", "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, name: "reviewer-5" }),
  );
  const b = bridge(userData, "session-5");
  t.after(b.stop);
  b.send({ id: 1, method: "initialize", params: {} });
  await until(
    () =>
      listTerminalSessions().sessions.find((s) => s.session === "session-5")?.name === "reviewer-5",
  );
});

test("a bridge on another protocol is listed as one to restart, and takes no pushes", async (t) => {
  const { sock } = await control(t, "d6");
  const changes: string[] = [];
  t.after(onEvent((e) => changes.push(e.what)));
  const old = hello(sock, { session: "session-6", cwd: temp });
  t.after(() => old.socket.destroy());
  assert.match(await old.first, /^outdated: restart this session/);
  assert.equal(
    listTerminalSessions().sessions.find((s) => s.session === "session-6")?.outdated,
    true,
  );
  assert.ok(changes.includes("terminal-sessions"));
  assert.match(
    await say(sock, `push ${JSON.stringify({ to: "session-6", text: "hi" })}`),
    /^error: session-6 runs an older coxswain bridge: restart that session/,
  );
  old.socket.destroy();
  await until(() => !listTerminalSessions().sessions.some((s) => s.session === "session-6"));
});

test("two sessions with one name, in two accounts, are pushed to by id", async (t) => {
  const { sock } = await control(t, "d7");
  const one = { protocol: 1, name: "twin", cwd: temp, route: "inbox" };
  const a = hello(sock, { ...one, session: "session-7a", account: "/a/.claude" });
  const b = hello(sock, { ...one, session: "session-7b", account: "/b/.claude-work" });
  t.after(() => {
    a.socket.destroy();
    b.socket.destroy();
  });
  assert.equal(await a.first, "ready");
  assert.equal(await b.first, "ready");
  assert.match(
    await say(sock, `push ${JSON.stringify({ to: "twin", text: "hi" })}`),
    /^error: 2 sessions are named twin \(session-7a in \/a\/\.claude, session-7b in \/b\/\.claude-work\): say which by id/,
  );
});
