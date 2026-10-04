import { useEffect, useRef, useState } from "react";
import { clockSeconds, type Machine, type Step } from "./model";

export type Command = {
  kind: string;
  label: string;
  hint?: string;
  run: () => void;
};

/** One input over the dimmed app: machines, steps and commands. */
export function Palette({
  machines,
  steps,
  commands,
  onPick,
  onSelect,
  onClose,
}: {
  machines: Machine[];
  steps: Step[];
  commands: Command[];
  onPick: (id: string) => void;
  onSelect: (step: Step) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const q = query.trim().toLowerCase();
  const rows: Command[] = [
    ...commands,
    ...machines.map((m, i) => ({
      kind: i < 9 ? String(i + 1) : "",
      label: m.device.name,
      hint: m.state,
      run: () => onPick(m.device.id),
    })),
    ...[...steps].reverse().map((s) => ({
      kind: clockSeconds(s.time),
      label: `${s.tool}  ${s.text}`,
      hint: "step",
      run: () => onSelect(s),
    })),
  ]
    .filter((r) => !q || `${r.label} ${r.hint ?? ""}`.toLowerCase().includes(q))
    .slice(0, 60);
  const choose = (row?: Command) => {
    if (!row) return;
    onClose();
    row.run();
  };
  return (
    <div
      id="pal"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        id="pal-box"
        className="slab"
        role="dialog"
        aria-label="Go to a machine, step or command"
      >
        <form
          id="pal-q"
          onSubmit={(e) => {
            e.preventDefault();
            choose(rows[active]);
          }}
        >
          <span className="ps" aria-hidden="true">
            ›
          </span>
          <input
            id="pal-in"
            ref={input}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="machine, step or command"
            aria-label="Go to"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = Math.max(1, rows.length);
                setActive(
                  (a) => (a + (e.key === "ArrowDown" ? 1 : -1) + n) % n,
                );
              } else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>esc</kbd>
        </form>
        <div id="pal-res" role="listbox">
          {rows.map((r, i) => (
            <button
              key={`${r.kind}${r.label}${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`pr${i === active ? " act" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <i>{r.kind}</i>
              <span>{r.label}</span>
              <small>{r.hint}</small>
            </button>
          ))}
          {!rows.length && <p className="ie">Nothing matches.</p>}
        </div>
      </div>
    </div>
  );
}
