import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The website: site/ builds into dist/site, which Vercel publishes. The demo's files are
// served as they are, so the page shows the game the demo builds at /game/index.html.
export default defineConfig({
  root: "site",
  publicDir: "../demo",
  plugins: [solid()],
  build: { outDir: "../dist/site", emptyOutDir: true },
});
