// node --test src/renderer/src/guide-links.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { guideLinkTarget, headingSlug } from "./guide-links.ts";

const thread = (
  id: number,
  body: string,
  more: { parentId?: number; resolvedAt?: string } = {},
) => ({
  id,
  body,
  parentId: more.parentId ?? null,
  resolvedAt: more.resolvedAt ?? null,
});

test("a heading's anchor is GitHub's", () => {
  assert.equal(headingSlug("Worth a look"), "worth-a-look");
  assert.equal(headingSlug("G1 + G2: Retry `fetch` on 503"), "g1--g2-retry-fetch-on-503");
  assert.equal(headingSlug("Outside backend (not reviewed)"), "outside-backend-not-reviewed");
});

test("a label goes to the thread that starts with it, an open one first", () => {
  const entries = [
    thread(1, "[G1-C1] old, fixed", { resolvedAt: "2026-11-20" }),
    thread(2, "a reply mentioning [G1-C1]", { parentId: 1 }),
    thread(3, "  [g1-c1] ⚡ still there"),
    thread(4, "see [G1-C1] above"),
  ];
  assert.deepEqual(guideLinkTarget("#G1-C1", entries, []), { thread: 3 });
  assert.deepEqual(guideLinkTarget("#G1-C1", entries.slice(0, 2), []), { thread: 1 });
});

test("otherwise a section whose heading has the anchor", () => {
  const headings = ["Review summary", null, "G1 + G2: Retry fetch", "Worth a look"];
  assert.deepEqual(guideLinkTarget("#worth-a-look", [], headings), { section: 3 });
  assert.deepEqual(guideLinkTarget("#g1-g2-retry-fetch", [], headings), { section: 2 });
  assert.deepEqual(guideLinkTarget("#Review%20summary", [], headings), { section: 0 });
});

test("nothing, an empty or a broken fragment goes nowhere", () => {
  assert.equal(guideLinkTarget("#nowhere", [thread(1, "[G1-C1] x")], ["Summary"]), null);
  assert.equal(guideLinkTarget("#", [], ["Summary"]), null);
  assert.equal(guideLinkTarget("#%E0%A4%A", [], ["Summary"]), null);
});
