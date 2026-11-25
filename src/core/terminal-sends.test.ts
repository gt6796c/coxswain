import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { connect, type Socket } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, mock, test } from "node:test";
import { openDatabase } from "./db.ts";

// ADR 0049: what the canvas sends to the agent, pushed to a terminal session instead. In a disposable home, as in
// terminal-tools.test.ts, since worktrees go there.
const temp = realpathSync(mkdtempSync(join(os.tmpdir(), "cx-sends-")));
const home = mock.method(os, "homedir", () => temp);
syncBuiltinESMExports();
const { openWorktree, openedWorktree } = await import("./git.ts");
const { startControl, openTarget } = await import("./open-target.ts");
const { addNote, liveEntries } = await import("./entries.ts");
const { sendToTerminal } = await import("./terminal-sends.ts");
const { listTerminalSessions } = await import("./terminal-sessions.ts");
const { terminalSession } = await import("./terminal-replies.ts");
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

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("timed out");
};

// A bridge written by hand: it says hello, then answers each push as `answer` says (ack by default), keeping them.
function session(sock: string, said: object) {
  const pushes: { id: number; text: string; meta: Record<string, string> }[] = [];
  let answer: (id: number) => object = (id) => ({ ack: id });
  const socket: Socket = connect(sock, () => socket.write(`session ${JSON.stringify(said)}\n`));
  socket.on("error", () => {});
  createInterface({ input: socket }).on("line", (line) => {
    if (!line.startsWith("{")) return;
    const { push } = JSON.parse(line);
    pushes.push(push);
    socket.write(`${JSON.stringify(answer(push.id))}\n`);
  });
  return { socket, pushes, answerWith: (a: typeof answer) => (answer = a) };
}

test("the canvas's questions, threads, reviews and checks go to a terminal session on the workspace", async (t) => {
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

  const db = openDatabase(join(temp, "sends.db"));
  t.after(() => db.destroy());
  const userData = join(temp, "data");
  mkdirSync(userData);
  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  const sock = join(userData, "control.sock");

  const { workspace } = await openTarget(db, { project: { path: repo }, branch: "feature" });
  const opened = await openWorktree(db, workspace.id);
  assert.equal(opened.status, "ok");
  const worktree = await openedWorktree(db, workspace.id);
  const s = session(sock, {
    protocol: 1,
    session: "s-1",
    name: "backend-b0",
    cwd: worktree,
    route: "inbox",
  });
  t.after(() => s.socket.destroy());
  await until(async () =>
    (await listTerminalSessions(db)).sessions.some((x) => x.workspace?.id === workspace.id),
  );
  const anchor = {
    path: "a.ts",
    side: "new" as const,
    startLine: 1,
    endLine: 1,
    code: "export const alpha = 1;",
    base: opened.status === "ok" ? opened.mergeBase : "",
    head: null,
  };
  const thread = async (id: number) =>
    (await liveEntries(db, workspace.id)).filter((e) => e.id === id || e.parentId === id);

  // A new question: saved as one, pushed with its thread, and the thread is the session's from then on.
  await sendToTerminal(db, "s-1", {
    kind: "question",
    question: { workspaceId: workspace.id, body: "Why alpha?", anchor },
  });
  const [question] = (await liveEntries(db, workspace.id)).filter((e) => e.body === "Why alpha?");
  assert.equal(question.kind, "question");
  assert.equal(s.pushes.length, 1);
  assert.deepEqual(s.pushes[0].meta, { kind: "comment", thread: String(question.id) });
  assert.match(s.pushes[0].text, new RegExp(`^Comment · thread ${question.id}\n`));
  assert.match(s.pushes[0].text, new RegExp(`reply_to_thread \\(thread_id ${question.id}\\)`));
  assert.match(
    s.pushes[0].text,
    /on `a\.ts` line 1[\s\S]*export const alpha = 1;[\s\S]*Me: Why alpha\?$/,
  );
  assert.equal(await terminalSession(db, question.id), "backend-b0");

  // A thread's Send to agent: the notes since its last question, with the whole thread.
  await addNote(db, {
    workspaceId: workspace.id,
    body: "And the old name?",
    parentId: question.id,
  });
  await sendToTerminal(db, "s-1", {
    kind: "thread",
    workspaceId: workspace.id,
    threadId: question.id,
  });
  assert.deepEqual(
    (await thread(question.id)).map((e) => e.kind),
    ["question", "question"],
  );
  assert.match(s.pushes[1].text, /Me: Why alpha\?\nMe: And the old name\?$/);
  await assert.rejects(
    sendToTerminal(db, "s-1", { kind: "thread", workspaceId: workspace.id, threadId: question.id }),
    /Nothing new in this thread/,
  );

  // Not delivered: the question becomes a note again, so the thread can be sent once more.
  s.answerWith((id) => ({ nack: id, error: "inbox closed" }));
  await assert.rejects(
    sendToTerminal(db, "s-1", {
      kind: "question",
      question: { workspaceId: workspace.id, body: "Still there?", parentId: question.id },
    }),
    /inbox closed/,
  );
  assert.equal((await thread(question.id)).at(-1)?.kind, "note");
  s.answerWith((id) => ({ ack: id }));

  // Submit Review's picked comment threads; an agent thread isn't one of them.
  const comment = await addNote(db, { workspaceId: workspace.id, body: "Rename it back", anchor });
  await sendToTerminal(db, "s-1", {
    kind: "review",
    workspaceId: workspace.id,
    threadIds: [comment.id, question.id],
  });
  const review = s.pushes.at(-1)!;
  assert.deepEqual(review.meta, { kind: "review", threads: `${comment.id},${question.id}` });
  assert.match(review.text, /^Review · 1 thread\n/);
  assert.match(
    review.text,
    new RegExp(`Thread ${comment.id}, on .a\\.ts.[\\s\\S]*Me: Rename it back$`),
  );
  await assert.rejects(
    sendToTerminal(db, "s-1", { kind: "thread", workspaceId: workspace.id, threadId: comment.id }),
    /A comment thread doesn't go to the agent/,
  );

  await sendToTerminal(db, "s-1", {
    kind: "check",
    workspaceId: workspace.id,
    name: "build",
    prompt: "It fails.",
  });
  assert.deepEqual(s.pushes.at(-1), {
    id: s.pushes.at(-1)!.id,
    text: "Check · build failed\nIt fails.",
    meta: { kind: "check", check: "build" },
  });

  // A session on another workspace, or none, is refused before anything is saved.
  s.socket.write(`${JSON.stringify({ pick: { pr: 9 } })}\n`);
  await until(async () => (await listTerminalSessions(db)).sessions[0]?.workspace === null);
  const before = (await liveEntries(db, workspace.id)).length;
  await assert.rejects(
    sendToTerminal(db, "s-1", {
      kind: "question",
      question: { workspaceId: workspace.id, body: "Lost?", anchor },
    }),
    /backend-b0 works on no workspace of coxswain's/,
  );
  assert.equal((await liveEntries(db, workspace.id)).length, before);
  await assert.rejects(
    sendToTerminal(db, "s-2", { kind: "check", workspaceId: workspace.id, name: "b", prompt: "p" }),
    /isn't connected now/,
  );
});
