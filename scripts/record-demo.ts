// Records the README's demo GIF, once in each theme, from what `ogidoc --demo` plays:
// the person picks a model, writes the plan and hands over; the scripted agent builds it
// and offers another way; the person looks at it and hands over again; then the game it
// built is opened and played. The site plays the same script live instead. Run with
// `npm run record`; it writes docs/demo{,-dark}.gif. Needs ffmpeg on the path.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const WIDTH = 1000;
const HEIGHT = 580;
const TA = 'textarea[aria-label="Plan text"]';
const SCRIPT = join(ROOT, "demo/tic-tac-toe.json");
const plan: string[] = JSON.parse(readFileSync(SCRIPT, "utf8")).plan;

// The folder the demo built, served as a site, so its page can be opened and played.
function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
  const server = createServer((req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "") || "index.html";
    try {
      const body = readFileSync(join(dir, path));
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}

// One take in one theme, on a fresh session. Frames come from the browser's own
// screencast, at twice the pixels, each held for as long as it was on screen; returns
// an ffmpeg concat list of them.
async function take(browser: Browser, colorScheme: "light" | "dark"): Promise<string> {
  const shots = mkdtempSync(join(tmpdir(), "ogidoc-shots-"));
  const project = mkdtempSync(join(tmpdir(), "ogidoc-record-"));
  const server = spawn(process.execPath, [join(ROOT, "bin/ogidoc.ts"), "tic-tac-toe", "--agent", "mock", "--script", SCRIPT, "--port", "0"], {
    cwd: project,
    env: { ...process.env, OGIDOC_HOME: mkdtempSync(join(tmpdir(), "ogidoc-home-")) },
  });
  const url = await new Promise<string>((resolve, reject) => {
    server.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/[\d.:]+/); if (m) resolve(m[0]); });
    server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, colorScheme });
  const page = await context.newPage();
  const frames: { file: string; at: number }[] = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(shots, `${String(frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, at: (metadata.timestamp ?? 0) * 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  const pause = (ms: number) => page.waitForTimeout(ms);
  // The agent's turn is over when the session says so.
  const turnOver = async () => {
    await page.waitForFunction(() => fetch("/api/state").then((r) => r.json()).then((s) => s.working), null, { polling: 100 });
    await page.waitForFunction(() => fetch("/api/state").then((r) => r.json()).then((s) => !s.working), null, { polling: 100, timeout: 30000 });
  };

  let game: { url: string; close: () => void } | null = null;
  try {
    await page.goto(url);
    await page.waitForSelector(TA);
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await pause(700);

    // Pick the model the turns run with.
    await page.click('.select[aria-label="model"]');
    await pause(700);
    await page.click('.option:has-text("Sonnet")');
    await pause(700);

    await page.focus(TA);
    for (const [i, line] of plan.entries()) {
      await page.keyboard.type(line.trimStart(), { delay: 40 });
      if (i === plan.length - 1) break;
      await page.keyboard.press("Enter");
      await page.$eval(TA, (el, want) => {
        // The editor keeps the line's indent on Enter; set it to the next line's.
        const ta = el as HTMLTextAreaElement;
        const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
        ta.setRangeText(want, start, ta.selectionStart, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }, plan[i + 1].match(/^ */)![0]);
    }
    await pause(800);

    await page.keyboard.press("Control+Enter");
    await turnOver();
    await pause(2600);

    // Look at the other way the agent offered, keep its pick, and hand over again. The
    // scripted agent always builds its own pick, so the clip doesn't switch for good.
    await page.$eval(TA, (el) => {
      const ta = el as HTMLTextAreaElement;
      const at = ta.value.indexOf("a taken cell does nothing");
      ta.focus();
      ta.setSelectionRange(at, at);
    });
    await pause(1000);
    await page.keyboard.press("Alt+BracketRight");
    await pause(1600);
    await page.keyboard.press("Alt+BracketLeft");
    await pause(1000);
    await page.keyboard.press("Control+Enter");
    await turnOver();
    await pause(2400);
    await page.keyboard.press("Control+Enter");
    await turnOver();
    await pause(2600);

    // Open what it built, and play: X takes the top row.
    game = await serve(project);
    await page.goto(`${game.url}/index.html`);
    await pause(1000);
    for (const cell of [1, 4, 2, 5, 3]) {
      await page.click(`button[aria-label="Cell ${cell}"]`);
      await pause(550);
    }
    await pause(2600);
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await context.close();
    game?.close();
    server.kill();
  }
  const list = join(shots, "frames.txt");
  const lines = frames.flatMap((f, i) => [`file '${f.file}'`, `duration ${(((frames[i + 1]?.at ?? f.at + 2000) - f.at) / 1000).toFixed(3)}`]);
  writeFileSync(list, [...lines, `file '${frames.at(-1)!.file}'`].join("\n") + "\n");
  return list;
}

const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const list = await take(browser, scheme);
    const name = scheme === "light" ? "demo" : "demo-dark";
    ff("-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=10,scale=${WIDTH * 2}:${HEIGHT * 2}:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, join(ROOT, `docs/${name}.gif`));
    console.log(`Wrote docs/${name}.gif`);
  }
} finally {
  await browser.close();
}
