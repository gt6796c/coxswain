import { match } from "ts-pattern";

// A Guide's scope (glossary): which part of the workspace's changes it covers, kept so updates and the stale check
// follow it. One of the diff's scopes (pushed is the glossary's PR scope), or pinned: a range the agent picked, whose
// base stays and whose head is the worktree only if it was the worktree when written.
export type GuideScope = "all" | "pushed" | "unpushed" | "uncommitted" | "pinned";
export const guideScopes = ["all", "pushed", "unpushed", "uncommitted", "pinned"] as const;
export const isGuideScope = (value: unknown): value is GuideScope =>
  guideScopes.includes(value as GuideScope);

// Where the scopes' ends are now: the merge base, what's on GitHub (the merge base until pushed), HEAD and the
// worktree as a commit. Missing (undefined or null) while not known yet.
export type ScopeEnds = {
  mergeBase?: string | null;
  pushed?: string | null;
  committed?: string | null;
  snapshot?: string | null;
};

// The range a Guide of this scope covers now; null while an end it needs isn't known.
export function rangeOf(
  guide: { scope: GuideScope; base: string; head: string; worktree: boolean },
  ends: ScopeEnds,
): { base: string; head: string } | null {
  const both = (base?: string | null, head?: string | null) =>
    base && head ? { base, head } : null;
  return match(guide.scope)
    .with("all", () => both(ends.mergeBase, ends.snapshot))
    .with("pushed", () => both(ends.mergeBase, ends.pushed))
    .with("unpushed", () => both(ends.pushed, ends.committed))
    .with("uncommitted", () => both(ends.committed, ends.snapshot))
    .with("pinned", () => (guide.worktree ? both(guide.base, ends.snapshot) : guide))
    .exhaustive();
}

// The scope a range picked by its ends is, when it lines up with one: base HEAD → the worktree is the uncommitted
// changes. All wins where two coincide (nothing committed yet).
export function scopeOf(
  range: { base: string; head: string; worktree: boolean },
  ends: Required<{ [K in keyof ScopeEnds]: string }>,
): GuideScope {
  return match(range)
    .with({ worktree: true, base: ends.mergeBase }, () => "all" as const)
    .with({ worktree: true, base: ends.committed }, () => "uncommitted" as const)
    .with({ worktree: false, base: ends.mergeBase, head: ends.pushed }, () => "pushed" as const)
    .with({ worktree: false, base: ends.pushed, head: ends.committed }, () => "unpushed" as const)
    .otherwise(() => "pinned" as const);
}
