import { useEffect, useState } from "react";
import { Download, ArrowUpRight } from "lucide-react";
import "./install-app.css";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallApp({ installUrl }: { installUrl?: string | null }) {
  const [installed, setInstalled] = useState(
    () =>
      matchMedia("(display-mode: standalone)").matches ||
      !!(navigator as Navigator & { standalone?: boolean }).standalone,
  );
  const [prompt, setPrompt] = useState<InstallPrompt>();
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const before = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const done = () => {
      setInstalled(true);
      setPrompt(undefined);
    };
    const mode = matchMedia("(display-mode: standalone)");
    const changed = () => {
      if (mode.matches) done();
    };
    window.addEventListener("beforeinstallprompt", before);
    window.addEventListener("appinstalled", done);
    mode.addEventListener("change", changed);
    return () => {
      window.removeEventListener("beforeinstallprompt", before);
      window.removeEventListener("appinstalled", done);
      mode.removeEventListener("change", changed);
    };
  }, []);
  if (installed) return null;
  const secureUrl = installUrl?.startsWith("https://") ? installUrl : undefined;
  return (
    <div className="install-app">
      <button
        className="text-button"
        disabled={busy}
        aria-expanded={help}
        onClick={async () => {
          if (!prompt) {
            setHelp((value) => !value);
            return;
          }
          setBusy(true);
          try {
            await prompt.prompt();
            const choice = await prompt.userChoice;
            if (choice.outcome === "accepted") setInstalled(true);
          } catch {
            setHelp(true);
          } finally {
            setPrompt(undefined);
            setBusy(false);
          }
        }}
      >
        <Download size={15} /> Install Gofer
      </button>
      {help && (
        <div className="install-app-help">
          {!window.isSecureContext ? (
            <>
              <p>Open the secure Gofer address to install the app.</p>
              {secureUrl && (
                <a href={secureUrl}>
                  Open secure app <ArrowUpRight size={13} />
                </a>
              )}
            </>
          ) : (
            <>
              <p>
                <strong>Android</strong> · Browser menu → Add to Home Screen →
                Install.
              </p>
              <p>
                <strong>iPhone / iPad</strong> · Share → Add to Home Screen.
              </p>
              <p className="muted">
                Keep Tailscale connected to reach your workspace.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function registerServiceWorker() {
  if (
    import.meta.env.PROD &&
    window.isSecureContext &&
    "serviceWorker" in navigator
  ) {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error) =>
        console.warn("Gofer offline screen unavailable:", error),
      );
  }
}
