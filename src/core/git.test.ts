import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asText, gitHubOf, gitHubOfRemote, parseLog } from "./git.ts";

test("images become data URLs, other binary files don't, text stays text", () => {
  const png = asText(Buffer.from([0x89, 0x50, 0, 1]), "logo.PNG");
  assert.deepEqual(png, {
    status: "ok",
    text: null,
    binary: true,
    image: "data:image/png;base64,iVAAAQ==",
  });
  assert.deepEqual(asText(Buffer.from([0, 1]), "a.bin"), {
    status: "ok",
    text: null,
    binary: true,
  });
  assert.deepEqual(asText(Buffer.from("hi"), "a.txt"), { status: "ok", text: "hi", binary: false });
});

test("the log gives each commit's author, co-authors, body and size", () => {
  const out =
    "\u001e12a3\u001fc8a5\u001fCy\u001fcy@x\u001f2026-10-01T00:42:35+02:00\u001fGitHub\u001fSecond\u001f\u001f\n\n 2 files changed, 3 insertions(+), 1 deletion(-)\n" +
    "\u001ec8a5\u001fa1 b2\u001fAnn\u001fann@x\u001f2026-10-01T00:42:35+02:00\u001fAnn\u001fMerge\u001fBody line\n\nCo-authored-by: Bob B <bob@x>\n\u001f\n";
  const [second, merge] = parseLog(out);
  assert.deepEqual(
    [
      second.sha,
      second.parent,
      second.author,
      second.committer,
      second.files,
      second.additions,
      second.deletions,
    ],
    ["12a3", "c8a5", "Cy", "GitHub", 2, 3, 1],
  );
  assert.deepEqual(
    [merge.parent, merge.merge, merge.body, merge.coAuthors, merge.files],
    ["a1", true, "Body line", ["Bob B"], 0],
  );
});

test("gitHubOf reads owner/name from github.com remotes only", () => {
  for (const url of [
    "git@github.com:acme/widgets.git",
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets.git",
    "https://user@github.com/acme/widgets/",
    "ssh://git@github.com/acme/widgets.git",
  ])
    assert.equal(gitHubOf(url), "acme/widgets", url);
  assert.equal(gitHubOf("git@github.com:acme/my.repo.git"), "acme/my.repo");
  assert.equal(gitHubOf("git@gitlab.com:acme/widgets.git"), null);
  assert.equal(gitHubOf("https://github.com.evil.example/acme/widgets"), null);
  assert.equal(gitHubOf(""), null);
});

test("gitHubOfRemote follows an SSH host alias to github.com", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "coxswain-ssh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config");
  writeFileSync(
    config,
    "Host work-github\n  HostName github.com\nHost work-gitlab\n  HostName gitlab.com\n",
  );
  const ssh = ["-F", config];
  assert.equal(await gitHubOfRemote("git@github.com:acme/widgets.git", ssh), "acme/widgets");
  for (const url of [
    "ssh://git@work-github/acme/widgets",
    "ssh://git@work-github:22/acme/widgets.git",
    "git@work-github:acme/widgets.git",
    "work-github:acme/widgets",
  ])
    assert.equal(await gitHubOfRemote(url, ssh), "acme/widgets", url);
  for (const url of [
    "git@work-gitlab:acme/widgets.git",
    "ssh://git@-oVisualHostKey/acme/widgets",
    "https://work-github/acme/widgets",
    "/srv/git/widgets.git",
    "",
  ])
    assert.equal(await gitHubOfRemote(url, ssh), null, url);
});
