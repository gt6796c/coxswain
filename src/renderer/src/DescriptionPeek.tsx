import {
  type ComponentProps,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { match } from "ts-pattern";
import { Button } from "./components/button";
import { XIcon } from "./components/icons";
import { canvasElement, restoreScroll } from "./components/restore-scroll";
import { cn, muted } from "./components/styles";
import { FragmentLinks, Prose } from "./components/text";
import type { DescriptionPeekStore } from "./description-peek";
import type { GuideReadingStore } from "./guide-reading-position";
import { ProseThreads } from "./ProseThreads";
import type { viewSections } from "./view-sections";
import { notInGuide, ViewProse } from "./ViewSection";

type Section = ReturnType<typeof viewSections>[number];

// Section Descriptions → On Demand: a Guide's file cards take the canvas's full width, each section showing only its
// heading, and the description shows in this panel over the canvas, opened with ⌘I or a section's Description button.
// It shows the section being read and changes as the user scrolls into the next one; the canvas never moves under it.
// A section's threads on its description are here, not on the canvas. A section of prose alone keeps its description
// on the canvas, threads and all: the panel shows that text without them.
export function DescriptionPeek(props: {
  peek: DescriptionPeekStore;
  readingPosition: GuideReadingStore;
  viewId: number;
  total: number; // the view's sections, for "03/08"
  writing: boolean;
  sections: Section[];
  threads: Omit<ComponentProps<typeof ProseThreads>, "viewId" | "section" | "children">;
}) {
  const peek = useSyncExternalStore(props.peek.subscribe, props.peek.getSnapshot);
  const reading = useSyncExternalStore(
    props.readingPosition.subscribe,
    props.readingPosition.getSnapshot,
  );
  const readingSection = reading?.viewId === props.viewId ? reading.section : 0;
  const last = useRef(readingSection);
  useEffect(() => {
    if (last.current === readingSection) return;
    last.current = readingSection;
    props.peek.follow();
  }, [readingSection]);

  const open = !!peek;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Escape in a field, the find bar or a dialog is theirs.
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
        return;
      props.peek.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const index = peek?.section ?? readingSection;
  const x = props.sections[index];

  // A thread revealed on this description: bring it into the panel's view. ProseThreads places it after layout.
  const body = useRef<HTMLDivElement>(null);
  const { revealThread, revealVersion } = props.threads;
  useEffect(() => {
    if (!open || revealThread === undefined) return;
    const frame = requestAnimationFrame(() => {
      const scroller = body.current;
      const thread = scroller?.querySelector(`[id="thread:${revealThread}"]`);
      if (!scroller || !thread) return;
      scroller.scrollTop +=
        thread.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, index, revealThread, revealVersion]);

  // The panel sits in the canvas's column, whose stale-Guide banner (when there is one) pushes the Guide down: keep the
  // panel below it. Measured on each render, which a banner coming or going causes.
  const panel = useRef<HTMLElement>(null);
  const [top, setTop] = useState<number>();
  useLayoutEffect(() => {
    const host = panel.current?.parentElement;
    const banner = host?.querySelector("[data-stale-guide-banner]");
    const below =
      host && banner
        ? banner.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 16
        : undefined;
    if (below !== top) setTop(below);
  });

  if (!peek || !x) return null;
  // A Guide link goes to a thread or section on the canvas: close the panel, which would cover it.
  const follow = props.threads.onLink;
  const onLink = follow
    ? (href: string) => {
        props.peek.close();
        follow(href);
      }
    : undefined;
  const prose = x.parts.flatMap((p, j) =>
    p.kind === "prose"
      ? [
          <ViewProse key={j} part={j}>
            {p.text}
          </ViewProse>,
        ]
      : [],
  );
  return (
    <aside
      ref={panel}
      aria-label="Section description"
      style={top === undefined ? undefined : { top, maxHeight: `calc(100% - ${top}px - 4.5rem)` }}
      className={cn(
        "absolute top-[var(--review-top-clearance)] left-[var(--review-gutter)] z-40 flex flex-col overflow-hidden",
        "max-h-[calc(100%-var(--review-top-clearance)-4.5rem)] w-[min(40rem,calc(100%-2*var(--review-gutter)))]",
        "rounded-2xl border border-[var(--review-file-border)] bg-[var(--review-file-bg)]",
        "shadow-[0_12px_40px_rgb(0_0_0/18%),0_2px_8px_rgb(0_0_0/8%)]",
      )}
    >
      <div className="flex shrink-0 items-start gap-3 px-6 pt-5 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {x.title !== null && (
            <span
              className={cn("font-mono text-xs tabular-nums", muted)}
              aria-label={`Section ${index + 1} of ${props.total}`}
            >
              {String(index + 1).padStart(2, "0")}/{String(props.total).padStart(2, "0")}
            </span>
          )}
          <h2 className="text-base font-semibold tracking-tight select-text">
            {x.title !== null ? <Prose inline>{x.title}</Prose> : notInGuide(props.writing)}
          </h2>
        </div>
        <Button
          variant="ghost"
          title="Close (⌘I or Esc)"
          aria-label="Close"
          className="-mr-2 p-1 text-neutral-500"
          onClick={props.peek.close}
        >
          <XIcon />
        </Button>
      </div>
      <div ref={body} className="min-h-0 overflow-y-auto px-6 pb-3">
        {match({ prose: prose.length > 0, files: x.files.length > 0 })
          .with({ prose: false }, () => (
            <p className={cn("pb-4 text-sm", muted)}>This section has no description.</p>
          ))
          .with({ files: true }, () => (
            <ProseThreads {...props.threads} onLink={onLink} viewId={props.viewId} section={index}>
              {prose}
            </ProseThreads>
          ))
          .otherwise(() => (
            // Guide links, which ProseThreads provides for a section with files.
            <FragmentLinks.Provider value={onLink}>{prose}</FragmentLinks.Provider>
          ))}
      </div>
    </aside>
  );
}

// In a section's heading on the canvas, On Demand: open the panel on this section.
export function DescriptionButton(props: { peek: DescriptionPeekStore; section: number }) {
  return (
    <Button
      variant="ghost"
      title="Show this section's description (⌘I)"
      className="-my-0.5 px-1.5 py-0.5"
      onClick={() => props.peek.open(props.section)}
    >
      Description
    </Button>
  );
}

// On Demand: a thread on a section's description is in the panel, not on the canvas. Scroll the canvas to the section's
// top, as choosing it in the Sections sidebar does, and open the panel on it.
export function revealInPeek(canvas: HTMLElement, peek: DescriptionPeekStore, section: number) {
  peek.open(section);
  const target = canvasElement(canvas, `view-section-${section}`);
  if (!target) return;
  return restoreScroll(canvas, {
    top: 0,
    anchor: target.id,
    offset: -(parseFloat(getComputedStyle(target).scrollMarginTop) || 0),
  });
}
