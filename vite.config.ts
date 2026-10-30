import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The editor's browser app: app/ builds into dist/web, which the server serves.
export default defineConfig({
  root: "app",
  plugins: [solid()],
  build: { outDir: "../dist/web", emptyOutDir: true },
});
