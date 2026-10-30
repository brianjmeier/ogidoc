import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The website: site/ builds into dist/site, which Vercel publishes.
export default defineConfig({
  root: "site",
  plugins: [solid()],
  build: { outDir: "../dist/site", emptyOutDir: true },
});
