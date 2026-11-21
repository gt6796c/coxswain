import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDatabase } from "./db.ts";
import { parseTarget, startControl } from "./open-target.ts";
import { listWorkspaces } from "./workspaces.ts";

const temp = realpathSync(mkdtempSync(join(os.tmpdir(), "coxswain-open-")));
after(() => rmSync(temp, { recursive: true, force: true }));
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("targets: a PR or a branch, of a GitHub repository or a local one", () => {
  const acme = { github: "acme/app" };
  assert.deepEqual(parseTarget("https://github.com/acme/app/pull/12/files"), {
    project: acme,
    pr: 12,
  });
  assert.deepEqual(parseTarget("acme/app#12"), { project: acme, pr: 12 });
  assert.deepEqual(parseTarget(" acme/app@fix/a-b \n"), { project: acme, branch: "fix/a-b" });
  assert.deepEqual(parseTarget("/code/my app#7"), { project: { path: "/code/my app" }, pr: 7 });
  assert.deepEqual(parseTarget("/code/app@feat/x"), {
    project: { path: "/code/app" },
    branch: "feat/x",
  });
  for (const bad of ["", "acme/app", "acme#12", "/code/app/#1", "code/app/x#1", "acme/app#x"])
    assert.equal(parseTarget(bad), null, bad);
});

const ask = (path: string, line: string) =>
  new Promise<string>((done, fail) => {
    let reply = "";
    // Ends its side once written, as `nc` does, and still reads the answer.
    const socket = connect(path, () => socket.end(`${line}\n`));
    socket.on("data", (d) => (reply += d));
    socket.on("end", () => done(reply));
    socket.on("error", fail);
  });

test("COXSWAIN_OPEN at launch, then a line on the control socket, open a branch workspace", async (t) => {
  const db = openDatabase(join(temp, "open.db"));
  t.after(() => db.destroy());
  const repo = join(temp, "code/app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  git(repo, "branch", "feature");
  git(repo, "branch", "other");

  const userData = join(temp, "data");
  mkdirSync(userData);
  process.env.COXSWAIN_OPEN = `${repo}@feature`;
  t.after(() => delete process.env.COXSWAIN_OPEN);
  const server = await startControl(db, userData);
  assert.ok(server);
  t.after(() => server.close());
  const sock = join(userData, "control.sock");
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  const branchesOpen = async () => {
    const [w] = await db.selectFrom("projects").select("id").execute();
    return (await listWorkspaces(db, w.id)).map((x) => x.branch).sort();
  };
  assert.deepEqual(await branchesOpen(), ["feature"]);

  assert.equal(await ask(sock, `${repo}@other`), "opened app: branch other\n");
  assert.deepEqual(await branchesOpen(), ["feature", "other"]);
  // Opening it again reuses it; a branch that isn't there isn't made.
  assert.equal(await ask(sock, `${repo}@other`), "opened app: branch other\n");
  assert.equal(await ask(sock, `${repo}@typo`), "error: app has no branch typo\n");
  assert.equal(await ask(sock, `${repo}#3`), "error: app isn't on GitHub, so it has no PRs\n");
  assert.match(await ask(sock, "nonsense"), /^error: can't read “nonsense”/);
  assert.deepEqual(await branchesOpen(), ["feature", "other"]);
});
