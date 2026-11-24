// A link in a Guide's prose to its own content (glossary "Guide link"): [G1-C1](#G1-C1) goes to the thread whose first
// comment starts with that label, [Worth a look](#worth-a-look) to the section with that heading. Fragments only, so
// the sanitizer keeps them and GitHub reads them the same way.
export type GuideLinkTarget = { thread: number } | { section: number };

type Thread = { id: number; body: string; parentId: number | null; resolvedAt: string | null };

// A heading's anchor as GitHub makes it: lower case, punctuation and emoji dropped, each space a dash. Inline code and
// links count as their text.
export function headingSlug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

// Runs of dashes count as one and ends don't count, so "g1--g2-x" and "g1-g2-x" are the same anchor.
const loose = (slug: string) => slug.replace(/-+/g, "-").replace(/^-|-$/g, "");

// Where a fragment link goes: first a thread labelled with it (an open one before a resolved one), then a section whose
// heading has it as its anchor. null when nothing has it.
export function guideLinkTarget(
  href: string,
  entries: readonly Thread[],
  headings: readonly (string | null)[],
): GuideLinkTarget | null {
  let name: string;
  try {
    name = decodeURIComponent(href.replace(/^#/, "")).trim();
  } catch {
    return null;
  }
  if (!name) return null;
  const label = `[${name.toLowerCase()}]`;
  const labelled = entries.filter(
    (e) => !e.parentId && e.body.trimStart().toLowerCase().startsWith(label),
  );
  const thread = labelled.find((e) => !e.resolvedAt) ?? labelled[0];
  if (thread) return { thread: thread.id };
  const anchor = loose(headingSlug(name));
  const section = headings.findIndex((h) => h !== null && loose(headingSlug(h)) === anchor);
  return section >= 0 ? { section } : null;
}
