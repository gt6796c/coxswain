import assert from "node:assert/strict";
import { test } from "node:test";
import { isGuideStale } from "./stale-guide.ts";

const ends = { mergeBase: "base", pushed: "pushed", committed: "head", snapshot: "snap" };

test("a Guide of all the changes becomes stale when either end of its range moves", () => {
  const guide = { guide: true, scope: "all" as const, worktree: true, base: "base", head: "snap" };
  assert.equal(isGuideStale(guide, ends), false);
  assert.equal(isGuideStale(guide, { ...ends, snapshot: "next" }), true);
  assert.equal(isGuideStale(guide, { ...ends, mergeBase: "new-base" }), true);
  assert.equal(isGuideStale(guide, { ...ends, mergeBase: undefined }), false);
  assert.equal(isGuideStale(guide, { ...ends, snapshot: null }), false);
  assert.equal(isGuideStale(null, ends), false);
  assert.equal(isGuideStale({ ...guide, guide: false }, { ...ends, snapshot: "next" }), false);
});

test("an uncommitted-only Guide follows HEAD and the worktree, not the merge base", () => {
  const guide = {
    guide: true,
    scope: "uncommitted" as const,
    worktree: true,
    base: "head",
    head: "snap",
  };
  assert.equal(isGuideStale(guide, ends), false);
  assert.equal(isGuideStale(guide, { ...ends, mergeBase: "elsewhere" }), false);
  assert.equal(isGuideStale(guide, { ...ends, committed: "new-head" }), true);
  assert.equal(isGuideStale(guide, { ...ends, snapshot: "next" }), true);
  assert.equal(isGuideStale(guide, { ...ends, committed: null }), false);
});

test("a pinned Guide keeps its base; only a worktree head moves on", () => {
  const pinned = { guide: true, scope: "pinned" as const, base: "other", head: "snap" };
  assert.equal(isGuideStale({ ...pinned, worktree: true }, ends), false);
  assert.equal(isGuideStale({ ...pinned, worktree: true }, { ...ends, snapshot: "next" }), true);
  const commit = { ...pinned, worktree: false, head: "abc" };
  assert.equal(isGuideStale(commit, { ...ends, snapshot: "next", mergeBase: "x" }), false);
});

test("Guides of the pushed and not-pushed scopes follow GitHub's head", () => {
  const pushed = { guide: true, scope: "pushed" as const, worktree: false, base: "base" };
  assert.equal(isGuideStale({ ...pushed, head: "pushed" }, ends), false);
  assert.equal(isGuideStale({ ...pushed, head: "pushed" }, { ...ends, pushed: "new" }), true);
  const unpushed = { guide: true, scope: "unpushed" as const, worktree: false, base: "pushed" };
  assert.equal(isGuideStale({ ...unpushed, head: "head" }, { ...ends, snapshot: "next" }), false);
  assert.equal(isGuideStale({ ...unpushed, head: "head" }, { ...ends, committed: "c2" }), true);
});
