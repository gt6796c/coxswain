import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { match, P } from "ts-pattern";
import type { Db } from "./db";
import { addLocalRepository, listBranches } from "./git.ts";
import { getPullRequestHead } from "./github.ts";
import { addGitHubProject, gitHubRepo, type Project } from "./projects.ts";
import { openBranchWorkspace, openPullRequestWorkspace, type Workspace } from "./workspaces.ts";

// ADR 0047: a PR or branch to open from outside the app, at launch (COXSWAIN_OPEN) or into the running app (a line on
// <userData>/control.sock). owner/name means coxswain's clone (ADR 0008), a /path the local repository there (ADR 0040).
export type Target =
  | { project: { github: string } | { path: string }; pr: number }
  | { project: { github: string } | { path: string }; branch: string };

// github.com/owner/name/pull/N[/…], owner/name#N, owner/name@branch, /path#N, /path@branch.
// ponytail: a path is cut at its first # or @, so a folder with either in its name can't be opened.
export function parseTarget(text: string): Target | null {
  const s = text.trim();
  const url = s.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (url) return { project: { github: url[1] }, pr: Number(url[2]) };
  const m = s.match(/^(\/[^#@]*[^#@/]|[\w.-]+\/[\w.-]+)(?:#(\d+)|@(.+))$/);
  if (!m) return null;
  const project = m[1].startsWith("/") ? { path: m[1] } : { github: m[1] };
  return m[2] ? { project, pr: Number(m[2]) } : { project, branch: m[3] };
}

// Adds the target's project and workspace if they're new, and makes both the current ones. A window shows them when
// the project changes, or at launch; in the project it's on, the new workspace tab appears and the shown one stays.
export async function openTarget(
  db: Db,
  target: Target,
): Promise<{ project: Project; workspace: Workspace }> {
  const project = await match(target.project)
    .with({ github: P.select() }, (fullName) => addGitHubProject(db, fullName))
    .with({ path: P.select() }, (path) => addLocalRepository(db, path))
    .exhaustive();
  if ("pr" in target) {
    if (!project.github) throw new Error(`${project.name} isn't on GitHub, so it has no PRs`);
    const { owner, name } = gitHubRepo(project);
    const head = await getPullRequestHead(owner, name, target.pr);
    if (head.status !== "ok") throw new Error(problemText(head));
    const workspace = await openPullRequestWorkspace(db, project.id, target.pr, head.headRef);
    return { project, workspace };
  }
  const branches = await listBranches(db, project.id);
  if (branches.status !== "ok") throw new Error(problemText(branches));
  if (!branches.branches.includes(target.branch))
    throw new Error(`${project.name} has no branch ${target.branch}`);
  const workspace = await openBranchWorkspace(
    db,
    project.id,
    target.branch,
    branches.defaultBranch,
  );
  return { project, workspace };
}

const problemText = (p: { status: string; message?: string }) =>
  match(p)
    .with({ status: "signed-out" }, () => "GitHub CLI isn't signed in (gh auth login)")
    .with({ status: "gh-missing" }, () => "GitHub CLI (gh) isn't installed")
    .otherwise((e) => e.message ?? e.status);

async function openText(db: Db, text: string): Promise<string> {
  const target = parseTarget(text);
  if (!target)
    throw new Error(
      `can't read “${text.trim()}”: give owner/name#N, owner/name@branch, /path#N or /path@branch`,
    );
  const { project, workspace } = await openTarget(db, target);
  const what =
    workspace.prNumber !== null ? `PR #${workspace.prNumber}` : `branch ${workspace.branch}`;
  return `${project.name}: ${what}`;
}

// COXSWAIN_OPEN first, so the window's first load lands on it, then the socket. A client writes one target as a line
// and gets one line back, "opened …" or "error: …", then the connection closes. The socket is the user's alone (0600).
// ponytail: no single-instance lock, so a second app on the same userData takes the socket over; start the second one
// with its own COXSWAIN_USER_DATA.
export async function startControl(db: Db, userData: string): Promise<Server | null> {
  const open = process.env.COXSWAIN_OPEN;
  if (open)
    await openText(db, open).then(
      (opened) => console.log(`COXSWAIN_OPEN: opened ${opened}`),
      (e: Error) => console.error(`COXSWAIN_OPEN: ${e.message}`),
    );
  const path = join(userData, "control.sock");
  // ponytail: macOS takes a socket path of at most 103 bytes; a deeper COXSWAIN_USER_DATA gets no socket. Upgrade: a
  // short path under /tmp named by a hash of userData, if that ever matters.
  if (Buffer.byteLength(path) > 103) {
    console.error(`control socket: ${path} is longer than the 103 bytes a socket path can be`);
    return null;
  }
  rmSync(path, { force: true });
  // Half-open: a client like `nc` closes its end once it has written the line, and still waits for the answer.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    const lines = createInterface({ input: socket });
    lines.once("line", (line) => {
      lines.close();
      void openText(db, line).then(
        (opened) => socket.end(`opened ${opened}\n`),
        (e: Error) => socket.end(`error: ${e.message}\n`),
      );
    });
  });
  // Never in the way of the window: without the socket, the app just can't be told what to open.
  const listening = await new Promise<boolean>((done) => {
    server.once("error", (e) => {
      console.error(`control socket: ${e.message}`);
      done(false);
    });
    server.listen(path, () => done(true));
  });
  if (!listening) return null;
  chmodSync(path, 0o600);
  server.unref();
  process.once("exit", () => rmSync(path, { force: true }));
  return server;
}
