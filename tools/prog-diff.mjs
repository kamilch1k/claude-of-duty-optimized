/**
 * WHICH shader permutation compiles during play, and what makes it different.
 *
 * Every hitch over 200 ms on the reporter's machine carried "+1 programs", but a
 * program NAME is not enough to act on — two permutations of the same material
 * share a name, which is how the last round of this ended in a wrong guess. So
 * this diffs three's `cacheKey`, which encodes the full define/parameter set and
 * uniquely identifies the permutation.
 *
 * Program counts and cache keys are pure CPU-side bookkeeping, so unlike frame
 * timings they read identically here and on real hardware. This probe is
 * trustworthy; a headless millisecond is not.
 *
 * For each new key it prints the token-level diff against the nearest existing
 * key, which names the actual difference (a define, a light count, a map slot)
 * rather than leaving it to be guessed.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?map=street&menu=0';
const SECONDS = Number(process.argv[3] ?? 30);

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(2000);

const res = await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const info = e.ctx.get('render').renderer.info;
      const inp = e.ctx.input;
      const snap = () => (info.programs ?? []).map((x) => ({ name: x.name, key: x.cacheKey ?? '' }));

      const baseline = snap();
      const seen = new Set(baseline.map((x) => x.key));
      const found = [];
      const keys = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
      let held = null;
      const t0 = performance.now();

      const tick = () => {
        const t = performance.now() - t0;
        const want = keys[Math.floor(t / 1500) % 4];
        if (want !== held) {
          if (held) inp._pendingUp.add(held);
          inp._pendingDown.add(want);
          held = want;
        }
        const phase = t % 1200;
        if (phase < 16) inp._pendingDown.add('Mouse0');
        else if (phase > 500 && phase < 516) inp._pendingUp.add('Mouse0');
        if (Math.floor(t / 2500) % 2 === 0) inp._rawLook.x += 5;

        for (const prog of snap()) {
          if (seen.has(prog.key)) continue;
          seen.add(prog.key);
          found.push({ t: Math.round(t), frame: e.time.frame, ...prog });
        }

        if (t > secs * 1000) {
          if (held) inp._pendingUp.add(held);
          inp._pendingUp.add('Mouse0');
          done({ baseline, found });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);

const { baseline, found } = res;
console.log(`baseline: ${baseline.length} programs after boot\n`);

if (!found.length) {
  console.log(`NO new programs in ${SECONDS}s of play — nothing compiles mid-game.`);
} else {
  const tok = (k) => new Set(String(k).split(/[,\s]+/).filter(Boolean));
  for (const f of found) {
    // nearest existing key by token overlap, so the diff is against a sibling
    let best = null;
    let bestScore = -1;
    const ft = tok(f.key);
    for (const c of baseline) {
      const ct = tok(c.key);
      let shared = 0;
      for (const x of ft) if (ct.has(x)) shared++;
      if (shared > bestScore) {
        bestScore = shared;
        best = { ...c, tokens: ct };
      }
    }
    const added = [...ft].filter((x) => !best.tokens.has(x));
    const removed = [...best.tokens].filter((x) => !ft.has(x));
    console.log(`NEW  "${f.name}"  at ${f.t}ms (frame ${f.frame})`);
    console.log(`  closest existing: "${best.name}"`);
    if (added.length) console.log(`  ONLY IN NEW:      ${added.join(' ')}`);
    if (removed.length) console.log(`  ONLY IN OLD:      ${removed.join(' ')}`);
    console.log('');
  }
  console.log(`${found.length} program(s) compiled during play`);
}

await b.close();
process.exit(found.length ? 1 : 0);
