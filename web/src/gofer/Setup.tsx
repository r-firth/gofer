// Setting a machine up for Gofer: what it has, what it lacks, and the way to supply each thing.
import { useEffect, useState, type FormEvent } from "react";
import { api, type Device } from "../api";

type Ready = {
  id: string;
  label: string;
  detail: string;
  state: "ok" | "missing" | "needs_you" | "optional";
  fix?: string | null;
  command?: string | null;
};

const FIX: Record<string, string> = {
  "cua-start": "start it",
  "spaces-start": "restart it",
  "spaces-install": "install it",
};
const STATE: Record<Ready["state"], string> = {
  ok: "ready",
  missing: "missing",
  needs_you: "needs you",
  optional: "optional",
};

/** Copies text. The page is served over plain http on the tailnet, where the clipboard API is
 *  not offered, so the old way is the one that works. */
function copy(text: string) {
  if (navigator.clipboard && isSecureContext)
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  area.remove();
  return Promise.resolve(done);
}

/** Text with any link in it made clickable (Tailscale's sign-in link arrives inside an error). */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https:\/\/[^\s"'<>]+)/).map((part, i) =>
        part.startsWith("https://") ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function Setup({ device }: { device: Device }) {
  const [items, setItems] = useState<Ready[]>();
  const [busy, setBusy] = useState("check");
  const [said, setSaid] = useState("");
  const [copied, setCopied] = useState("");
  async function check() {
    setBusy("check");
    try {
      const result = await api<{ items: Ready[] }>(
        `/devices/${device.id}/readiness`,
      );
      setItems(result.items);
    } catch (e) {
      // Not reaching the machine is itself the answer to the first question.
      setItems([
        {
          id: "ssh",
          label: "ssh",
          state: "needs_you",
          detail: `Gofer could not log in to ${device.target ?? device.name}: ${e instanceof Error ? e.message : String(e)}`,
        },
      ]);
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    setItems(undefined);
    setSaid("");
    void check();
  }, [device.id]);
  async function apply(step: string) {
    setBusy(step);
    setSaid("");
    try {
      const result = await api<{ items: Ready[]; output: string }>(
        `/devices/${device.id}/setup/${step}`,
        {},
      );
      setItems(result.items);
      setSaid(result.output.trim().split("\n").slice(-8).join("\n"));
    } catch (e) {
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  const open = items?.filter(
    (i) => i.state === "missing" || i.state === "needs_you",
  ).length;
  return (
    <div className="vbox setup">
      <div className="setup-h">
        <b>
          {!items
            ? `Looking at ${device.name}`
            : open
              ? `${open} ${open === 1 ? "thing" : "things"} to set up on ${device.name}`
              : `${device.name} is ready`}
        </b>
        <button
          type="button"
          className="kbtn"
          disabled={Boolean(busy)}
          onClick={check}
        >
          {busy === "check" ? "checking" : "check again"}
        </button>
      </div>
      {items?.map((i) => (
        <div key={i.id} className={`sr ${i.state}`}>
          <span className="sl">
            <i className="d" />
            {i.label}
          </span>
          <span className="sd">
            <em>{STATE[i.state]}</em>
            <Linked text={i.detail} />
            {i.command && <code>{i.command}</code>}
          </span>
          <span className="sa">
            {i.fix && (
              <button
                type="button"
                className="kbtn"
                disabled={Boolean(busy)}
                onClick={() => apply(i.fix!)}
              >
                {busy === i.fix ? "working" : (FIX[i.fix] ?? "fix it")}
              </button>
            )}
            {i.command && (
              <button
                type="button"
                className="kbtn"
                onClick={() =>
                  void copy(i.command!).then((done) => {
                    setCopied(done ? i.id : "");
                    setTimeout(() => setCopied(""), 1500);
                  })
                }
              >
                {copied === i.id ? "copied" : "copy command"}
              </button>
            )}
          </span>
        </div>
      ))}
      {said && <pre className="setup-out">{said}</pre>}
    </div>
  );
}

/** Adds a machine Gofer can reach over SSH but did not find on the tailnet. */
export function AddMachine({
  onAdded,
  onCancel,
}: {
  onAdded: (device: Device) => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!target.trim()) return;
    setSaving(true);
    setError("");
    try {
      const device = await api<Device>("/devices", {
        target: target.trim(),
        name: name.trim(),
      });
      // Reaching it once marks it online or says why not.
      await api(`/devices/${device.id}/probe`, {}).catch(() => {});
      onAdded(device);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="vbox setup" onSubmit={add}>
      <div className="setup-h">
        <b>Add a machine</b>
        <button type="button" className="kbtn" onClick={onCancel}>
          cancel
        </button>
      </div>
      <p className="setup-p">
        Any machine the Gofer host can ssh into. Machines on your tailnet are
        found by themselves; this is for the rest.
      </p>
      <label className="sf">
        <span>ssh destination</span>
        <input
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="user@host, or an alias from ~/.ssh/config"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <label className="sf">
        <span>name</span>
        <input
          autoComplete="off"
          spellCheck={false}
          placeholder="what to call it (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="setup-h">
        <span className="setup-e">{error}</span>
        <button
          type="submit"
          className="kbtn on"
          disabled={saving || !target.trim()}
        >
          {saving ? "adding" : "add and check it"}
        </button>
      </div>
    </form>
  );
}
