import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The package's own folder, whether this runs from source or from the compiled dist/.
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("Couldn't find Ogidoc's package.json.");
    dir = up;
  }
  return dir;
}

const ROOT = packageRoot();
export const AGENT_DIR = join(ROOT, "agent");
// The demo: a plan to start from, and the turns a scripted agent plays on it.
export const DEMO_DIR = join(ROOT, "demo");
// Ogimap: its editor and its demo ship as files beside the compiled code.
export const MAP_DIR = join(ROOT, "labs", "ogimap");
// The ogidoc command itself, as this copy runs it: compiled in the package, the source in
// a checkout. Git calls it back to merge the map.
const HERE = fileURLToPath(import.meta.url);
export const CLI = HERE.includes(`${join("dist", "src")}`) ? join(ROOT, "dist", "bin", "ogidoc.js") : join(ROOT, "bin", "ogidoc.ts");
// Built by `npm run build`.
export const WEB_DIR = join(ROOT, "dist", "web");
