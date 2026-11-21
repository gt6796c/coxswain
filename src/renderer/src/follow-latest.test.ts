import assert from "node:assert/strict";
import { test } from "node:test";
import { atEnd } from "./follow-latest.ts";

test("a scroller within the slack of its end is at its end", () => {
  assert.equal(atEnd({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), true);
  assert.equal(atEnd({ scrollHeight: 1000, clientHeight: 400, scrollTop: 580 }), true);
});

test("a scroller scrolled up, or whose content grew past the slack, is not at its end", () => {
  assert.equal(atEnd({ scrollHeight: 1000, clientHeight: 400, scrollTop: 500 }), false);
  assert.equal(atEnd({ scrollHeight: 1200, clientHeight: 400, scrollTop: 600 }), false);
});

test("content shorter than the scroller is at its end", () => {
  assert.equal(atEnd({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 }), true);
});
