/**
 * Shared bake harness.
 *
 * The game generates every asset on the GPU or in Web Audio, so the baker has
 * to run inside a real browser: vite serves the modules, headless Chromium
 * provides WebGL2 and OfflineAudioContext, and Node only writes the files.
 *
 * The pieces here are the ones every baker needs — a dev server, a page, a
 * frame pump, console capture — so `bake-*.mjs` scripts stay about the assets.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../..');

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );
}

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

/**
 * Spawn vite through `node bin/vite.js` rather than the `.bin` shim: the shim
 * is a shell script, `vite.cmd` is a batch file, and neither spawns correctly
 * from Node on Windows.
 */
export async function ensureServer(port) {
  if (await portOpen(port)) return { proc: null, spawned: false };
  const proc = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore' }
  );
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(port)) return { proc, spawned: true };
  }
  proc.kill();
  throw new Error('vite failed to start');
}

function gpuArgs(software) {
  if (software) return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const base = [
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
  ];
  if (process.platform === 'darwin') return [...base, '--use-angle=metal'];
  if (process.platform === 'win32') return [...base, '--use-angle=d3d11'];
  return base;
}

export async function launch({ software = false, width = 1024, height = 1024, extraArgs = [] } = {}) {
  const browser = await chromium.launch({ headless: true, args: [...gpuArgs(software), ...extraArgs] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  return { browser, page, logs };
}

export async function open(page, port, path, { timeout = 300000 } = {}) {
  await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction('window.__READY__ === true', null, { timeout });
}

/** Advance real animation frames; rAF-driven generators need the clock to move. */
export async function pump(page, frames = 12) {
  await page.evaluate(
    (n) =>
      new Promise((done) => {
        let i = 0;
        const tick = () => (++i >= n ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames
  );
}

export function interestingLogs(logs, limit = 20) {
  return logs.filter((l) => /\[error\]|\[pageerror\]|\[warning\]/.test(l)).slice(0, limit);
}

/** Run vite + browser around a callback, tearing both down afterwards. */
export async function withHarness(port, fn, opts = {}) {
  const { proc } = await ensureServer(port);
  const h = await launch(opts);
  try {
    return await fn(h);
  } finally {
    await h.browser.close();
    if (proc) proc.kill();
  }
}
