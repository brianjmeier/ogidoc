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
// Built by `npm run build`.
export const WEB_DIR = join(ROOT, "dist", "web");
