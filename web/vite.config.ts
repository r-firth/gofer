import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { randomUUID } from "node:crypto";

export default defineConfig(({ command }) => {
  const buildId = command === "build" ? randomUUID() : "";
  return {
    define: { "import.meta.env.VITE_HUB_BUILD_ID": JSON.stringify(buildId) },
    plugins: [
      react(),
      {
        name: "hub-build-manifest",
        apply: "build",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "build.json",
            source: JSON.stringify({ build_id: buildId }),
          });
        },
      },
    ],
    server: {
      proxy: { "/api": { target: "http://127.0.0.1:4318", ws: true } },
    },
  };
});
