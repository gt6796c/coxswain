import { BrowserWindow } from "electron";
import { onShowThread } from "../core/show-thread";

// ADR 0048: show_thread from a terminal session. The window goes to the thread; it comes forward without taking the
// keyboard from the terminal the user is typing in.
export function forwardShowThread() {
  onShowThread((root) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.showInactive();
    win.webContents.send("show-thread", root);
  });
}
