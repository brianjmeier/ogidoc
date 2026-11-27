import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

// The editor's browser app: app/ builds into dist/web, which the server serves.
export default defineConfig({
  root: "app",
  plugins: [solid()],
  resolve: { dedupe: ["solid-js", "@solidjs/web"] },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
