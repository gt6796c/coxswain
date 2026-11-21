import { useEffect, useRef } from "react";
import type { ReviewEntry } from "../../core/review";

// ADR 0048: a terminal session's show_thread. The latest onShow runs, so it sees the canvas as it is now.
export function useShowThread(onShow: (root: ReviewEntry) => void) {
  const latest = useRef(onShow);
  latest.current = onShow;
  useEffect(() => window.coxswain.onShowThread((root) => latest.current(root)), []);
}
