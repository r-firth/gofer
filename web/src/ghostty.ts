import type { TerminalResources } from "./terminal-session";
let runtime: Promise<typeof import("ghostty-web")> | undefined;
function loadRuntime() {
  return (runtime ??= (async () => {
    const module = await import("ghostty-web");
    await module.init();
    return module;
  })().catch((error) => {
    runtime = undefined;
    throw error;
  }));
}
/** How a terminal looks. The inherited client's look is the default; Gofer passes its own. */
export type TerminalLook = {
  font: string;
  size: number;
  cursor: "bar" | "block";
  theme: Record<string, string>;
};
const DEFAULT_LOOK: TerminalLook = {
  font: "IBM Plex Mono",
  size: 14,
  cursor: "bar",
  theme: {
    background: "#101011",
    foreground: "#ede9e3",
    cursor: "#fb9760",
    selectionBackground: "#ffffff22",
    black: "#22241f",
    red: "#ee8a77",
    green: "#99c998",
    yellow: "#e3c18a",
    blue: "#86b5da",
    magenta: "#c7a4cb",
    cyan: "#8dc5c2",
    white: "#dedfd5",
  },
};
export async function createGhosttyTerminal(
  look: TerminalLook = DEFAULT_LOOK,
): Promise<TerminalResources> {
  const face = `${look.size}px "${look.font}"`;
  const [{ Terminal, FitAddon }] = await Promise.all([
    loadRuntime(),
    document.fonts.load(face),
    document.fonts.load(`bold ${face}`),
    document.fonts.load(`italic ${face}`),
    // FontFaceSet.load defaults to a space; request PUA glyphs explicitly.
    document.fonts.load(
      `${look.size}px "Symbols Nerd Font Mono"`,
      "\ue0b0\uf120\uf07c\uf179",
    ),
  ]);
  const terminal = new Terminal({
    fontFamily: `"${look.font}", "Symbols Nerd Font Mono", monospace`,
    fontSize: look.size,
    cursorBlink: true,
    cursorStyle: look.cursor,
    scrollback: 10000,
    theme: look.theme,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  return { terminal, fit };
}
