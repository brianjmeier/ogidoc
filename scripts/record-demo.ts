// Records the demo clip for the README and the site: the person writes a plan, hands
// over, the scripted agent builds it and offers another way, the person looks at it and
// hands over again. Run with `npm run record`; it writes site/public/demo.mp4,
// site/public/demo-poster.png and docs/demo.gif. Needs ffmpeg on the path.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const WIDTH = 1000;
const HEIGHT = 580;
const dir = mkdtempSync(join(tmpdir(), "ogidoc-record-"));
const videos = mkdtempSync(join(tmpdir(), "ogidoc-video-"));

const server = spawn(process.execPath, [join(ROOT, "bin/ogidoc.ts"), "weekly", "--agent", "mock", "--script", join(ROOT, "demo/weekly.json"), "--port", "0"], {
  cwd: dir,
  env: { ...process.env, OGIDOC_HOME: mkdtempSync(join(tmpdir(), "ogidoc-home-")) },
});
const url = await new Promise<string>((resolve, reject) => {
  server.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/[\d.:]+/); if (m) resolve(m[0]); });
  server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});

const TA = 'textarea[aria-label="Plan text"]';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: "light", recordVideo: { dir: videos, size: { width: WIDTH, height: HEIGHT } } });
const page = await context.newPage();
const pause = (ms: number) => page.waitForTimeout(ms);
// The agent's turn is over when the session says so.
const turnOver = async () => {
  await page.waitForFunction(() => fetch("/api/state").then((r) => r.json()).then((s) => s.working), null, { polling: 100 });
  await page.waitForFunction(() => fetch("/api/state").then((r) => r.json()).then((s) => !s.working), null, { polling: 100, timeout: 30000 });
};

try {
  await page.goto(url);
  await page.waitForSelector(TA);
  await pause(700);
  const plan = readFileSync(join(ROOT, "demo/demo.plan"), "utf8").trimEnd();
  await page.focus(TA);
  for (const line of plan.split("\n")) {
    await page.keyboard.type(line.trimStart(), { delay: 45 });
    if (line !== plan.split("\n").at(-1)) {
      await page.keyboard.press("Enter");
      const indent = plan.split("\n")[plan.split("\n").indexOf(line) + 1].match(/^ */)![0];
      await page.$eval(TA, (el, want) => {
        // The editor keeps the line's indent on Enter; set it to the next line's.
        const ta = el as HTMLTextAreaElement;
        const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
        ta.setRangeText(want, start, ta.selectionStart, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }, indent);
    }
  }
  await pause(900);

  await page.keyboard.press("Control+Enter");
  await turnOver();
  await pause(2600);

  // Look at the other way the agent offered, keep its pick, and hand over again. The
  // scripted agent always builds its own pick, so the clip doesn't switch for good.
  await page.$eval(TA, (el) => {
    const ta = el as HTMLTextAreaElement;
    const at = ta.value.indexOf("in the browser's timezone");
    ta.focus();
    ta.setSelectionRange(at, at);
  });
  await pause(1200);
  await page.keyboard.press("Alt+BracketRight");
  await pause(1800);
  await page.keyboard.press("Alt+BracketLeft");
  await pause(1200);
  await page.keyboard.press("Control+Enter");
  await turnOver();
  await pause(3200);
} finally {
  await context.close();
  await browser.close();
  server.kill();
}

const webm = join(videos, readdirSync(videos).find((f) => f.endsWith(".webm"))!);
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
ff("-ss", "0.6", "-i", webm, "-c:v", "libx264", "-crf", "26", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(ROOT, "site/public/demo.mp4"));
ff("-sseof", "-1", "-i", webm, "-frames:v", "1", "-update", "1", join(ROOT, "site/public/demo-poster.png"));
ff("-ss", "0.6", "-i", webm, "-vf", "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", join(ROOT, "docs/demo.gif"));
console.log("Wrote site/public/demo.mp4, site/public/demo-poster.png and docs/demo.gif");
