// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InstallApp } from "./InstallApp";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () =>
    root.render(<InstallApp installUrl="https://hub.example.ts.net" />),
  );
}
async function click() {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(".install-app button")!.click(),
  );
}
it("only invokes the browser install prompt on user click and hides after installation", async () => {
  await mount();
  const prompt = vi.fn(async () => {});
  await act(async () =>
    window.dispatchEvent(
      Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
        prompt,
        userChoice: Promise.resolve({ outcome: "accepted" }),
      }),
    ),
  );
  expect(prompt).not.toHaveBeenCalled();
  await click();
  expect(prompt).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new Event("appinstalled")));
  expect(document.querySelector(".install-app")).toBeNull();
});
it("offers browser-menu instructions when no native prompt is available", async () => {
  await mount();
  await click();
  expect(document.body.textContent).toContain("Add to Home Screen");
});
it("sends HTTP visitors to the configured HTTPS app for installation", async () => {
  vi.stubGlobal("isSecureContext", false);
  await mount();
  await click();
  expect(document.body.textContent).toContain("secure");
  expect(document.querySelector(".install-app a")?.getAttribute("href")).toBe(
    "https://hub.example.ts.net",
  );
});
it("does not advertise installation inside the installed app", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  await mount();
  expect(document.querySelector(".install-app")).toBeNull();
});
