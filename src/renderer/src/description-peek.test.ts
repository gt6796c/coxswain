import assert from "node:assert/strict";
import { test } from "node:test";
import { createDescriptionPeek } from "./description-peek.ts";

test("toggle opens the panel on the section being read and closes it again", () => {
  const peek = createDescriptionPeek();
  assert.equal(peek.getSnapshot(), null);
  peek.toggle();
  assert.deepEqual(peek.getSnapshot(), {});
  peek.toggle();
  assert.equal(peek.getSnapshot(), null);
});

test("a section asked for holds until the reader moves on, then the panel follows the reading position", () => {
  const peek = createDescriptionPeek();
  peek.open(3);
  assert.deepEqual(peek.getSnapshot(), { section: 3 });
  peek.follow();
  assert.deepEqual(peek.getSnapshot(), {});
  peek.toggle();
  assert.equal(peek.getSnapshot(), null, "toggle closes a panel opened on a section too");
});

test("closing or following when there's nothing to change doesn't notify", () => {
  const peek = createDescriptionPeek();
  let updates = 0;
  const unsubscribe = peek.subscribe(() => updates++);
  peek.close();
  peek.follow();
  assert.equal(updates, 0);
  peek.open();
  peek.follow();
  assert.equal(updates, 1, "a panel already following the reading position stays as it is");
  unsubscribe();
  peek.close();
  assert.equal(updates, 1);
});
