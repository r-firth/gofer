// Exercise real WASM allocation/reuse across desktop and mobile history views.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ghostty } from '../web/node_modules/ghostty-web/dist/ghostty-web.js';
import { terminalHistoryOutput } from '../web/src/terminal-history-output.ts';

const wasm = await readFile(new URL('../web/node_modules/ghostty-web/ghostty-vt.wasm', import.meta.url));
const engine = await Ghostty.load(`data:application/wasm;base64,${wasm.toString('base64')}`);
const config = { scrollbackLimit: 10000, fgColor: 0xede9e3, bgColor: 0x101011 };
for (const cols of [67, 38, 67, 38]) {
  const term = engine.createTerminal(80, 24, config);
  try {
    // Match opening and resizing a canvas terminal before loading its snapshot.
    term.getCursor(); term.getViewport(); term.clearDirty();
    term.resize(cols, 29);
    term.getCursor(); term.getViewport(); term.clearDirty();
    const lines = Array.from({ length: 250 }, (_, i) => {
      const label = `HISTORY_${String(i + 1).padStart(4, '0')}`;
      return i % 7 === 0 ? label.padEnd(cols, 'X') : label;
    });
    term.write(terminalHistoryOutput(lines.map(line => `\x1b[32m${line}\x1b[39m`).join('\n')));
    term.update();
    const actual = Array.from({ length: term.getScrollbackLength() }, (_, i) => term.getScrollbackLine(i));
    for (let i = 0; i < term.rows; i++) actual.push(term.getLine(i));
    const text = actual.map(row => row.map(c => String.fromCodePoint(c.codepoint || 32)).join('').trimEnd());
    assert.deepEqual(text, lines, `Reopening history at ${cols} columns corrupted captured lines`);
    term.getViewport();
  } finally {
    term.free();
  }
}
console.log('PASS: Ghostty history preserves every line across repeated desktop/mobile views, including full-width lines');
