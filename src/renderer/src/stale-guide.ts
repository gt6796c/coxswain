import type { View } from "../../core/views";
import { rangeOf, type ScopeEnds } from "../../shared/guide-scope.ts";

// A Guide is stale once its scope's range moved on from the one it was written for: an uncommitted-only Guide when
// HEAD or the worktree moves, not when the merge base does. An end not known yet must not flash a stale warning.
export function isGuideStale(
  guide: Pick<View, "guide" | "base" | "head" | "scope" | "worktree"> | null,
  ends: ScopeEnds,
) {
  if (!guide?.guide) return false;
  const now = rangeOf(guide, ends);
  return !!now && (now.base !== guide.base || now.head !== guide.head);
}
