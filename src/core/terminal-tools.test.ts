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
const { addLocalRepository, openWorktree, openedWorktree } = await import("./git.ts");
const { startControl, openTarget } = await import("./open-target.ts");
const { writeCatalog } = await import("./terminal-tools.ts");
const { addNote } = await import("./entries.ts");
const { onShowThread } = await import("./show-thread.ts");
const { terminalSession, waitForTerminal } = await import("./terminal-replies.ts");
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
// sessionId is the Claude Code session's (CLAUDE_CODE_SESSION_ID); none by default, as these tests may run inside one.
function bridge(cwd: string, userData: string, sessionId = "") {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bridgeScript], {
    cwd,
    env: { ...process.env, COXSWAIN_USER_DATA: userData, CLAUDE_CODE_SESSION_ID: sessionId },
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

const say = (sock: string, line: string) =>
  new Promise<string>((done, fail) => {
    const socket = connect(sock, () => socket.write(`${line}\n`));
    createInterface({ input: socket }).once("line", (line) => {
      socket.destroy();
      done(line);
    });
    socket.on("error", fail);
  });
const hello = (sock: string, cwd: string) => say(sock, `mcp ${JSON.stringify({ cwd })}`);

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

  // Replies on what a named session adds wait for it in read_review. A finding added before the session names itself
  // says to, and naming claims it too.
  await session.call("start_guide");
  const finding = (body: string) =>
    session.call("add_finding", { path: "a.ts", side: "new", start_line: 1, end_line: 1, body });
  assert.match((await finding("[G1-C1] unnamed")).text, /Call set_session_name now/);
  const findings = async () =>
    db
      .selectFrom("entries")
      .select(["id", "body"])
      .where("kind", "=", "finding")
      .orderBy("id")
      .execute();
  assert.equal(await terminalSession(db, (await findings())[0].id), null);
  assert.deepEqual(await session.call("set_session_name", { name: " backend-b0 " }), {
    isError: false,
    text: "Replies on the findings and explanations you add, and the 1 you added before, wait for backend-b0 in read_review.",
  });
  assert.doesNotMatch((await finding("[G1-C2] named")).text, /set_session_name/);
  const [unnamed, named] = await findings();
  assert.equal(await terminalSession(db, unnamed.id), "backend-b0");
  assert.equal(await terminalSession(db, named.id), "backend-b0");
  // A new entry given a deleted thread's id isn't the session's, and a setting from before startedAt is ignored.
  await db
    .updateTable("entries")
    .set({ created_at: "2000-01-01T00:00:00.000Z" })
    .where("id", "=", unnamed.id)
    .execute();
  assert.equal(await terminalSession(db, unnamed.id), null);
  await db
    .updateTable("settings")
    .set({ value: "backend-b0" })
    .where("key", "=", `terminal.replies.${unnamed.id}`)
    .execute();
  assert.equal(await terminalSession(db, unnamed.id), null);
  assert.equal((await session.call("read_review")).text, "No open thread waits on you.");
  assert.equal(
    await waitForTerminal(db, {
      workspaceId: workspace.id,
      body: "Is this right?",
      parentId: named.id,
    }),
    null,
  );
  const waiting = (await session.call("read_review")).text;
  assert.match(waiting, new RegExp(`^1 open thread\\(s\\)[^]*Thread ${named.id}, on`));
  assert.match(waiting, /Me: Is this right\?$/);
  assert.equal((await session.call("finish_guide")).isError, false);

  // A directory coxswain can't make a workspace of is refused on the socket, and the bridge passes that on.
  assert.match(await hello(sock, temp), /^error: .* isn't in a git repository/);
  git(repo, "checkout", "-q", "--detach");
  const unchecked = `${repo} has no branch checked out. Call use_workspace with the branch or PR to review.`;
  assert.equal(await hello(sock, repo), `error: ${unchecked}`);
  const detached = bridge(repo, userData);
  t.after(detached.close);
  assert.ok((await detached.names()).includes("read_review"));
  assert.deepEqual(await detached.call("read_review"), {
    isError: true,
    text: `coxswain: ${unchecked}`,
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

test("a session in the main checkout picks the branch to review with use_workspace", async (t) => {
  const repo = join(temp, "code/svc");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "b.ts"), "export const beta = 1;\n");
  git(repo, "commit", "-qam", "rename");
  git(repo, "checkout", "-q", "main");

  const db = openDatabase(join(temp, "picked.db"));
  t.after(() => db.destroy());
  const userData = join(temp, "picked");
  mkdirSync(userData);
  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  await addLocalRepository(db, repo);
  await writeCatalog(db, userData);
  // git.ts remembers opened worktrees by workspace id for the whole process: keep clear of the first test's id 1.
  git(repo, "branch", "spare");
  await openTarget(db, { project: { path: repo }, branch: "spare" });

  // The main checkout is on the branch workspaces start from: nothing to review, and the error says what to do.
  const session = bridge(repo, userData, "session-dd");
  t.after(session.close);
  assert.ok((await session.names()).includes("use_workspace"));
  const onMain = `coxswain: ${repo} is on main, the branch svc's workspaces start from, so it has no changes to review. Call use_workspace with the branch or PR to review, or start the session in that branch's worktree.`;
  assert.deepEqual(await session.call("read_review"), { isError: true, text: onMain });
  // A name given before there's a workspace is kept for the connection use_workspace opens.
  const naming = await session.call("set_session_name", { name: "backend-dd" });
  assert.equal(naming.isError, true);
  assert.match(naming.text, /The name is kept/);

  assert.match(
    (await session.call("use_workspace", { branch: "feature", pr: 1 })).text,
    /not both/,
  );
  const missing = await session.call("use_workspace", { branch: "nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /has no branch nope/);

  const picked = await session.call("use_workspace", { branch: "feature" });
  const workspace = await db
    .selectFrom("workspaces")
    .select("id")
    .where("branch", "=", "feature")
    .executeTakeFirstOrThrow();
  const worktree = await openedWorktree(db, workspace.id);
  assert.deepEqual(picked, {
    isError: false,
    text: `coxswain now works on svc: branch feature, its code in ${worktree}. Every coxswain tool uses this workspace until you call use_workspace again.`,
  });
  assert.equal((await session.call("read_review")).text, "No open thread waits on you.");
  // The Guide's start names the workspace, for a session that moved since it started to check against.
  assert.match(
    (await session.call("start_guide")).text,
    new RegExp(
      `This Guide is for svc: branch feature, its code in ${worktree}\\. If you're reviewing`,
    ),
  );
  assert.match((await session.call("list_changed_files")).text, /b\.ts/);
  const finding = await session.call("add_finding", {
    path: "b.ts",
    side: "new",
    start_line: 1,
    end_line: 1,
    body: "[G1-C1] beta",
  });
  assert.equal(finding.isError, false);
  assert.doesNotMatch(finding.text, /set_session_name/);
  assert.equal((await session.call("finish_guide")).isError, false);

  // Going back to the main checkout's branch is refused like the first call, and the pick holds.
  assert.deepEqual(await session.call("use_workspace"), { isError: true, text: onMain });
  assert.equal((await session.call("read_review")).text, "No open thread waits on you.");

  // A new bridge for the same Claude Code session (/mcp reconnect) carries on with its pick and name; another session's
  // starts over in its directory's branch.
  session.close();
  const again = bridge(repo, userData, "session-dd");
  t.after(again.close);
  await again.rpc("initialize");
  const after = await again.call("add_finding", {
    path: "b.ts",
    side: "new",
    start_line: 1,
    end_line: 1,
    body: "[G1-C2] after the reconnect",
  });
  assert.equal(after.isError, false);
  assert.doesNotMatch(after.text, /set_session_name/);
  const other = bridge(repo, userData, "session-other");
  t.after(other.close);
  assert.deepEqual(await other.call("read_review"), { isError: true, text: onMain });

  // Removing the workspace drops it and the pick: the next call, and the next bridge, are back in the main checkout.
  const removed = await again.call("remove_workspace");
  assert.deepEqual(removed, {
    isError: false,
    text: `coxswain removed the workspace (svc: branch feature, its code in ${worktree}), with its Guide and review threads. Its worktree and branch are still there. Your next coxswain call works on the branch where you run, or on what use_workspace picks.`,
  });
  const gone = await db
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspace.id)
    .executeTakeFirst();
  assert.equal(gone, undefined);
  assert.deepEqual(await again.call("read_review"), { isError: true, text: onMain });
  again.close();
  const later = bridge(repo, userData, "session-dd");
  t.after(later.close);
  assert.deepEqual(await later.call("read_review"), { isError: true, text: onMain });

  // A hook that removed the user's worktree of a branch removes its workspaces, without opening anything.
  assert.equal((await later.call("use_workspace", { branch: "feature" })).isError, false);
  const sock = join(userData, "control.sock");
  const remove = (said: object) => say(sock, `remove ${JSON.stringify(said)}`);
  assert.equal(await remove({ repo: temp, branch: "feature" }), "removed 0");
  assert.equal(await remove({ repo: repo, branch: "feature" }), "removed 1");
  assert.equal(
    await db
      .selectFrom("workspaces")
      .select("id")
      .where("branch", "=", "feature")
      .executeTakeFirst(),
    undefined,
  );
  assert.match(await remove({ repo }), /^error: say which/);
});
