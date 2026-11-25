import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { openDatabase } from "./db.ts";
import { startControl } from "./open-target.ts";

// Terminal comms spike: coxswain pushes a message to a connected terminal session, through the real bridge.
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

// The bridge as Claude Code starts it, collecting what it writes to the session.
// Without an inbox unless given one: these tests may run inside a Claude Code session, whose own inbox must not get pushes.
function bridge(userData: string, sessionId: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [bridgeScript], {
    cwd: temp,
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
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
  return { child, next, send };
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("timed out");
};

test("coxswain pushes a message to a connected session, which gets it as a channel event", async (t) => {
  const userData = join(temp, "d1");
  mkdirSync(userData, { recursive: true });
  const db = openDatabase(join(temp, "sessions.db"));
  t.after(() => db.destroy());
  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  const sock = join(userData, "control.sock");

  const b = bridge(userData, "session-1", { COXSWAIN_PUSH: "channel" });
  t.after(() => b.child.kill());
  b.send({ id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
  const init = (await b.next((m) => m.id === 1)).result as Record<string, unknown>;
  // A channel on the newest MCP revision isn't taken as one.
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual((init.capabilities as { experimental: object }).experimental, {
    "claude/channel": {},
  });

  await until(async () => (await say(sock, "sessions")).includes("session-1"));
  assert.match(await say(sock, "sessions"), /\(unnamed\) session-1 in /);

  const pushed = await say(
    sock,
    `push ${JSON.stringify({ to: "session-1", text: "Review lines 3-9 of a.ts", meta: { file: "a.ts", "bad-key": "x" } })}`,
  );
  assert.equal(pushed, "delivered to session-1");
  const event = await b.next((m) => m.method === "notifications/claude/channel");
  assert.deepEqual(event.params, {
    content: "Review lines 3-9 of a.ts",
    meta: { file: "a.ts", push_id: "1" },
  });

  assert.match(
    await say(sock, `push ${JSON.stringify({ to: "nobody", text: "hi" })}`),
    /^error: no session nobody is connected; connected: \(unnamed\) session-1/,
  );
  assert.match(await say(sock, "push {}"), /^error: say whom and what/);
});

test("a session's bridge connects again when coxswain comes back", async (t) => {
  const userData = join(temp, "d2");
  mkdirSync(userData, { recursive: true });
  const db = openDatabase(join(temp, "restart.db"));
  t.after(() => db.destroy());
  const sock = join(userData, "control.sock");

  // The bridge starts before the app.
  const b = bridge(userData, "session-2");
  t.after(() => b.child.kill());
  b.send({ id: 1, method: "initialize", params: {} });
  await b.next((m) => m.id === 1);

  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  await until(async () => (await say(sock, "sessions")).includes("session-2"));
});

test("by default a push goes into the session's own inbox socket, as a message from coxswain", async (t) => {
  const userData = join(temp, "d3");
  mkdirSync(userData, { recursive: true });
  const db = openDatabase(join(temp, "inbox.db"));
  t.after(() => db.destroy());
  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  const sock = join(userData, "control.sock");

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
    CLAUDE_CODE_MESSAGING_SOCKET: inboxPath,
    CLAUDE_CODE_MESSAGING_TOKEN: "tok",
  });
  t.after(() => b.child.kill());
  b.send({ id: 1, method: "initialize", params: {} });
  await b.next((m) => m.id === 1);
  await until(async () => (await say(sock, "sessions")).includes("session-3"));

  const push = { to: "session-3", text: "Review a.ts:3-9", meta: { file: "a.ts" } };
  assert.equal(await say(sock, `push ${JSON.stringify(push)}`), "delivered to session-3");
  await until(async () => received.length === 1);
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

  // A session with no inbox says so instead of timing out.
  const none = bridge(userData, "session-4");
  t.after(() => none.child.kill());
  none.send({ id: 1, method: "initialize", params: {} });
  await none.next((m) => m.id === 1);
  await until(async () => (await say(sock, "sessions")).includes("session-4"));
  assert.match(
    await say(sock, `push ${JSON.stringify({ to: "session-4", text: "hi" })}`),
    /^error: session-4 couldn't take it: the session has no inbox socket/,
  );
});
