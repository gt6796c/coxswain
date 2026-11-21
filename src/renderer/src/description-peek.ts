// Section Descriptions → On Demand: whether the description panel is open over the canvas, and for which section.
// Open with no section, it shows the section being read (the reading position) and follows it as the user scrolls;
// opened on a section (its Description button, a thread revealed on its description), it shows that one until the
// reader moves to another section. Like the reading position, a store outside React state: opening and closing the
// panel must not rerender the review canvas and its file cards.
export type DescriptionPeek = { section?: number } | null;

export function createDescriptionPeek() {
  let peek: DescriptionPeek = null;
  const listeners = new Set<() => void>();
  const set = (next: DescriptionPeek) => {
    peek = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => peek,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggle: () => set(peek ? null : {}),
    open: (section?: number) => set({ section }),
    close: () => {
      if (peek) set(null);
    },
    // The reader moved to another section: show the one being read again.
    follow: () => {
      if (peek?.section !== undefined) set({});
    },
  };
}
export type DescriptionPeekStore = ReturnType<typeof createDescriptionPeek>;
