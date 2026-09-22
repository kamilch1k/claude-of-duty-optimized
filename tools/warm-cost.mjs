/**
 * What each prewarm set costs at boot, and what it buys during play.
 *
 * The trade is real in both directions: warming nothing means the driver
 * translates shaders on the first trigger pull, warming everything blocks the
 * load screen for tens of seconds. This runs each set end to end and reports
 * both sides so the choice is made on numbers.
 *
 * Boot milliseconds here are inflated — headless Chromium has no GPU and
 * compiles through SwiftShader — so read them as RELATIVE cost between sets, not
 * as what the player waits. The play-phase program/geometry/texture counts are
 * CPU-side bookkeeping and are exact on any machine.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const SETS = ['lite', 'play', '1'];
const SECONDS = 20;

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const rows = [];

for (const set of SETS) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  let boot = null;
  p.on('console', (m) => {
    const s = m.text();
    const hit = /\[boot\] playable in (\d+) ms/.exec(s);
    if (hit) boot = Number(hit[1]);
  });
  p.on('pageerror', (e) => console.log(`[pageerror ${set}]`, e.message));

  const t0 = Date.now();
  await p.goto(`${BASE}?map=street&menu=0&warm=${set}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 600000 });
  const wall = Date.now() - t0;
  await p.waitForTimeout(1500);

  const play = await p.evaluate(
    (secs) =>
      new Promise((done) => {
        const e = window.__ENGINE__;
        const info = e.ctx.get('render').renderer.info;
        const inp = e.ctx.input;
        const start = {
          p: info.programs.length,
          g: info.memory.geometries,
          t: info.memory.textures,
        };
        const keys = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
        let held = null;
        const t0 = performance.now();
        const tick = () => {
          const t = performance.now() - t0;
          const want = keys[Math.floor(t / 1200) % 4];
          if (want !== held) {
            if (held) inp._pendingUp.add(held);
            inp._pendingDown.add(want);
            held = want;
          }
          const phase = t % 1000;
          if (phase < 16) inp._pendingDown.add('Mouse0');
          else if (phase > 400 && phase < 416) inp._pendingUp.add('Mouse0');
          inp._rawLook.x += 5;
          if (t > secs * 1000) {
            if (held) inp._pendingUp.add(held);
            inp._pendingUp.add('Mouse0');
            done({
              programs: info.programs.length - start.p,
              geometries: info.memory.geometries - start.g,
              textures: info.memory.textures - start.t,
              total: info.programs.length,
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    SECONDS
  );

  rows.push({ set, boot: boot ?? wall, wall, ...play });
  await p.close();
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `\n${pad('warm set', 10)}${pad('boot ms', 10)}${pad('programs', 10)}${pad('+prog', 8)}${pad('+geo', 8)}+tex`
);
console.log('-'.repeat(54));
for (const r of rows) {
  console.log(
    pad(r.set === '1' ? 'full' : r.set, 10) +
      pad(r.boot, 10) +
      pad(r.total, 10) +
      pad(r.programs, 8) +
      pad(r.geometries, 8) +
      r.textures
  );
}
console.log(`\n+cols are allocations DURING ${SECONDS}s of play — lower is fewer hitches.`);
await b.close();
