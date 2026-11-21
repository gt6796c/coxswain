import { useEffect, useRef, useState, type RefObject } from "react";

// Within this many pixels of the end counts as at the end: sub-pixel rounding and the last line's padding.
const slack = 24;
export const atEnd = (el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= slack;

// Keeps a scroller at its end while the reader is there: content growing (a streamed answer, a new turn) or the
// scroller shrinking (a taller composer) scrolls it along. Once the reader scrolls away from the end it stays put and
// `atEnd` is false, for a Jump to Latest control; scrolling back to the end follows again.
// content: the scroller's one child, whose size is the content's.
export function useFollowLatest(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
) {
  const following = useRef(true);
  // The scrollTop this hook last set. Its scroll event can arrive after the content grew again, no longer at the end:
  // that is not the reader leaving the end, so it is ignored.
  const ours = useRef<number | null>(null);
  const [end, setEnd] = useState(true);
  const toEnd = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    ours.current = el.scrollTop;
    following.current = true;
    setEnd(true);
  };
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const onScroll = () => {
      if (el.scrollTop === ours.current) return;
      ours.current = null;
      following.current = atEnd(el);
      setEnd(following.current);
    };
    const observer = new ResizeObserver(() => {
      if (following.current) toEnd(el);
      else setEnd(atEnd(el));
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(el);
    observer.observe(inner);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);
  return {
    atEnd: end,
    jumpToEnd: () => {
      if (scroller.current) toEnd(scroller.current);
    },
  };
}
