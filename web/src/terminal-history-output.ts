/** Convert tmux's styled capture into a fresh terminal snapshot. */
export function terminalHistoryOutput(text: string): string {
  // Ghostty 0.4 can retain old cells when reusing a resized history allocation.
  // Clear each row before painting it, including the unused trailing columns.
  // Erasing after the text would delete the last cell of a full-width line.
  return "\x1bc\x1b[?25l\x1b[2K" + text.replace(/\r?\n/g, "\r\n\x1b[2K");
}
