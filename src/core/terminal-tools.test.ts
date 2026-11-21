import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, mock, test } from "node:test";
import { openDatabase } from "./db.ts";

// ADR 0048, in a disposable home as in local-repositories.test.ts: a terminal session's tools through the bridge.
const temp = realpathSync(mkdtempSync(join(os.tmpdir(), "coxswain-terminal-")));
const home = mock.method(os, "homedir", () => temp);
syncBuiltinESMExports();
const { openWorktree, openedWorktree } = await import("./git.ts");
const { startControl, openTarget } = await import("./open-target.ts");
const { writeCatalog } = await import("./terminal-tools.ts");
const { addNote } = await import("./entries.ts");
const { onShowThread } = await import("./show-thread.ts");
home.mock.restore();
syncBuiltinESMExports();
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});
after(() => rmSync(temp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const bridgeScript = join(import.meta.dirname, "../../scripts/coxswain-mcp.mjs");

// The bridge as Claude Code runs it: a child in the session's directory, one JSON-RPC message per line.
function bridge(cwd: string, userData: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bridgeScript], {
    cwd,
    env: { ...process.env, COXSWAIN_USER_DATA: userData },
  });
  child.stderr.pipe(process.stderr);
  child.on("exit", (code) => {
    for (const w of waiting.values()) w({ result: { exited: code } });
  });
  const waiting = new Map<number, (reply: { result: Record<string, unknown> }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    waiting.get(reply.id)?.(reply);
  });
  let id = 0;
  const rpc = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((done) => {
      waiting.set(++id, (r) => done(r.result));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const names = async () =>
    ((await rpc("tools/list")).tools as { name: string }[]).map((t) => t.name);
  const call = async (name: string, args: object = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })) as {
      isError: boolean;
      content: { text: string }[];
    };
    return { isError: r.isError, text: r.content[0].text };
  };
  return { rpc, names, call, close: () => child.kill() };
}

const hello = (sock: string, cwd: string) =>
  new Promise<string>((done, fail) => {
    const socket = connect(sock, () => socket.write(`mcp ${JSON.stringify({ cwd })}\n`));
    createInterface({ input: socket }).once("line", (line) => {
      socket.destroy();
      done(line);
    });
    socket.on("error", fail);
  });

test("a terminal session gets its branch's tools, reads the user's comments and answers them", async (t) => {
  const repo = join(temp, "code/app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "a.ts"), "export const alpha = 1;\n");
  git(repo, "commit", "-qam", "rename");
  git(repo, "checkout", "-q", "main");

  const db = openDatabase(join(temp, "terminal.db"));
  t.after(() => db.destroy());
  const userData = join(temp, "data");
  mkdirSync(userData);
  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  const sock = join(userData, "control.sock");

  // Before coxswain knows the repository, a session there lists no tools.
  const outside = bridge(repo, userData);
  t.after(outside.close);
  assert.deepEqual((await outside.rpc("initialize")).serverInfo, {
    name: "coxswain",
    version: "0",
  });
  assert.deepEqual(await outside.names(), []);

  // The session runs in coxswain's worktree of feature (one the user checked out themselves needs ADR 0046).
  const { workspace } = await openTarget(db, { project: { path: repo }, branch: "feature" });
  const opened = await openWorktree(db, workspace.id);
  assert.equal(opened.status, "ok");
  const worktree = await openedWorktree(db, workspace.id);
  await writeCatalog(db, userData);

  const session = bridge(worktree, userData);
  t.after(session.close);
  await session.rpc("initialize");
  const tools = await session.names();
  for (const name of ["start_guide", "write_section", "add_finding", "read_review"])
    assert.ok(tools.includes(name), name);
  assert.ok(!tools.includes("publish_guide"));

  assert.deepEqual(await session.call("read_review"), {
    isError: false,
    text: "No open thread waits on you.",
  });
  const note = await addNote(db, {
    workspaceId: workspace.id,
    body: "Why alpha?",
    anchor: {
      path: "a.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      code: "export const alpha = 1;",
      base: opened.status === "ok" ? opened.mergeBase : "",
      head: null,
    },
  });
  const review = await session.call("read_review");
  assert.match(
    review.text,
    new RegExp(`^1 open thread\\(s\\)[^]*Thread ${note.id}, on \`a.ts\` line 1`),
  );
  assert.match(review.text, /Me: Why alpha\?$/);

  assert.match(
    (await session.call("reply_to_thread", { thread_id: 999, body: "x" })).text,
    /No thread 999/,
  );
  assert.deepEqual(
    await session.call("reply_to_thread", { thread_id: note.id, body: "It reads better." }),
    {
      isError: false,
      text: `Replied in thread ${note.id}.`,
    },
  );
  assert.equal((await session.call("read_review")).text, "No open thread waits on you.");
  // With all, a thread where the agent spoke last (as an earlier review's findings do) is listed too.
  const everything = await session.call("read_review", { all: true });
  assert.match(everything.text, new RegExp(`^1 open thread\\(s\\)[^]*Thread ${note.id}, on`));
  assert.match(everything.text, /You: It reads better\.$/);

  // show_thread hands the thread's first entry to the window, by id or by words only it has.
  assert.match((await session.call("show_thread", { thread_id: note.id })).text, /no window open/);
  const shown: number[] = [];
  const stop = onShowThread((root) => shown.push(root.id));
  assert.equal(
    (await session.call("show_thread", { text: "alpha?" })).text,
    `coxswain shows thread ${note.id} (a.ts).`,
  );
  assert.deepEqual(shown, [note.id]);
  assert.match((await session.call("show_thread", { text: "nowhere" })).text, /No thread has/);
  assert.match((await session.call("show_thread", { thread_id: 999 })).text, /No thread 999/);
  assert.match((await session.call("show_thread", {})).text, /Give thread_id or text/);
  stop();
  await session.call("resolve_thread", { thread_id: note.id });
  assert.equal((await session.call("read_review", { all: true })).text, "No open thread.");
  const root = await db
    .selectFrom("entries")
    .select("resolved_at")
    .where("id", "=", note.id)
    .executeTakeFirstOrThrow();
  assert.ok(root.resolved_at);
  assert.equal((await session.call("finish_guide")).isError, false);

  // A directory coxswain can't make a workspace of is refused on the socket, and the bridge passes that on.
  assert.match(await hello(sock, temp), /^error: .* isn't in a git repository/);
  git(repo, "checkout", "-q", "--detach");
  assert.equal(await hello(sock, repo), `error: ${repo} has no branch checked out`);
  const detached = bridge(repo, userData);
  t.after(detached.close);
  assert.ok((await detached.names()).includes("read_review"));
  assert.deepEqual(await detached.call("read_review"), {
    isError: true,
    text: `coxswain: ${repo} has no branch checked out`,
  });

  // No app: the tools are still listed, from the catalog, and a call says to start it.
  const stopped = join(temp, "stopped");
  mkdirSync(stopped);
  copyFileSync(join(userData, "terminal-tools.json"), join(stopped, "terminal-tools.json"));
  const later = bridge(worktree, stopped);
  t.after(later.close);
  assert.ok((await later.names()).includes("read_review"));
  assert.deepEqual(await later.call("read_review"), {
    isError: true,
    text: "coxswain isn't running. Start it, then call the tool again.",
  });
});
