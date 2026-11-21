import type { ReviewEntry } from "./entries.ts";

// ADR 0048: a terminal session asks coxswain to show a thread (show_thread). The core knows nothing of windows, so it
// hands the thread's first entry to whoever listens: the main process, which tells the window to go there.
const listeners = new Set<(root: ReviewEntry) => void>();
export function onShowThread(listener: (root: ReviewEntry) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
// Whether anyone was there to show it.
export function requestShowThread(root: ReviewEntry): boolean {
  listeners.forEach((l) => l(root));
  return listeners.size > 0;
}
