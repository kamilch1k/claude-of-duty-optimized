/**
 * FRAME PACING ON A REAL GPU.
 *
 * Every other tool here either hand-pumps the engine (CPU cost, no GPU) or runs
 * headless (a software rasteriser, so every draw number is fiction). This runs
 * the engine's own requestAnimationFrame loop on the actual adapter and reports
 * the frame-time DISTRIBUTION plus the dropped-frame count against a target
 * refresh — because "average fps" hides exactly the stutter a player notices.
 *
 *   node tools/pacing.mjs [url] [seconds]
 *   node tools/pacing.mjs "http://127.0.0.1:5173/?map=street&menu=0&q=performance" 30
 *
 * Prints the adapter it actually got. If that says SwiftShader the run is void.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?map=street&menu=0';
const SECONDS = Number(process.argv[3] ?? 30);

const b = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--force_high_performance_gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--mute-audio',
    '--window-position=0,0',
    '--window-size=1290,780',
  ],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });

const gpu = await p.evaluate(() => {
  const gl = window.__ENGINE__.ctx.peek('render').renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`GPU: ${gpu}`);
if (/swiftshader|software|llvmpipe|warp/i.test(gpu)) {
  await b.close();
  throw new Error('software rasteriser — this run cannot report frame pacing');
}

// Measure the STEADY STATE, after boot and the first shadow cascade fit.
await p.waitForTimeout(4000);

const out = await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const inp = e.ctx.input;
      const render = e.ctx.peek('render');
      const info = () => render.renderer.info;
      const keys = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
      const dts = [];
      /** Anything slow enough to feel, with whatever the engine knows about it. */
      const slow = [];
      /**
       * Programs are tracked by IDENTITY, and their cache key is kept, because a
       * name is not enough to act on: two permutations of the same material
       * share one. The key encodes the full define/parameter set.
       *
       * This has to run on the real adapter. Headless reports "no new programs"
       * for the same session in which hardware creates three, because three
       * folds device capabilities into that key.
       */
      const seenProgs = new Map();
      for (const pr of info().programs ?? []) seenProgs.set(pr.id, pr);

      /**
       * The other half: a mesh drawn for the first time. `info.memory.geometries`
       * ticks on first bind, so the count names nothing — walking the scenes and
       * reporting the mesh whose geometry uuid is new names the culprit.
       */
      const seenGeo = new Set();
      const sweep = () => {
        const found = [];
        for (const root of [e.ctx.scene, e.ctx.viewScene]) {
          if (!root) continue;
          root.traverse((o) => {
            if (!o.isMesh && !o.isPoints && !o.isLine) return;
            if (o.visible === false) return;
            if (!o.geometry || seenGeo.has(o.geometry.uuid)) return;
            seenGeo.add(o.geometry.uuid);
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const mname = mats.filter(Boolean).map((m) => m.name || m.type).slice(0, 2).join('+');
            found.push(`${o.name || o.type} [${o.geometry.type} ${mname}]`);
          });
        }
        return found;
      };
      for (const root of [e.ctx.scene, e.ctx.viewScene]) {
        if (!root) continue;
        root.traverse((o) => { if (o.geometry) seenGeo.add(o.geometry.uuid); });
      }
      let held = null;
      let last = performance.now();
      let prev = { p: info().programs?.length ?? 0, g: info().memory.geometries, t: info().memory.textures };
      const t0 = last;
      const tick = () => {
        const now = performance.now();
        const dt = now - last;
        dts.push(dt);
        last = now;

        const cur = { p: info().programs?.length ?? 0, g: info().memory.geometries, t: info().memory.textures };
        const d = { p: cur.p - prev.p, g: cur.g - prev.g, t: cur.t - prev.t };
        prev = cur;

        // 40 ms is where a frame stops being a frame miss and starts being felt.
        if (dt > 40) {
          const sys = {};
          for (const [k, v] of e._sysMs ?? []) sys[k] = +v.toFixed(1);
          /** New programs on this frame, with the permutation that makes them new. */
          const fresh = [];
          for (const pr of info().programs ?? []) {
            if (seenProgs.has(pr.id)) continue;
            seenProgs.set(pr.id, pr);
            let diff = '';
            let best = 0;
            for (const [, other] of seenProgs) {
              if (other === pr || other.name !== pr.name || !other.cacheKey) continue;
              const a = String(other.cacheKey).split(',');
              const b = String(pr.cacheKey ?? '').split(',');
              const d2 = b.filter((x) => !a.includes(x)).length;
              if (d2 > best) { best = d2; diff = b.filter((x) => !a.includes(x)).slice(0, 8).join(','); }
            }
            fresh.push({ name: pr.name ?? 'unnamed', diff, key: String(pr.cacheKey ?? '').slice(0, 300) });
          }
          const newGeo = d.g > 0 ? sweep() : [];
          slow.push({
            at: Math.round(now - t0),
            dt: +dt.toFixed(1),
            frame: e.time.frame,
            sys,
            dProg: d.p, dGeo: d.g, dTex: d.t,
            fresh,
            newGeo,
          });
        }

        const t = now - t0;
        const want = keys[Math.floor(t / 1200) % 4];
        if (want !== held) {
          if (held) inp._pendingUp.add(held);
          inp._pendingDown.add(want);
          held = want;
        }
        const phase = t % 1000;
        if (phase < 16) inp._pendingDown.add('Mouse0');
        else if (phase > 400 && phase < 416) inp._pendingUp.add('Mouse0');
        inp._rawLook.x += 6;

        if (t > secs * 1000) {
          if (held) inp._pendingUp.add(held);
          inp._pendingUp.add('Mouse0');
          done({ dts, slow });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);

await b.close();

const s = out.dts.slice(2).sort((a, c) => a - c);
const q = (x) => s[Math.min(s.length - 1, Math.floor(s.length * x))];
const mean = s.reduce((a, c) => a + c, 0) / s.length;
const over = (ms) => s.filter((v) => v > ms).length;

console.log(`${s.length} frames in ${SECONDS}s\n`);
console.log(`  p50   ${q(0.5).toFixed(1)} ms   (${(1000 / q(0.5)).toFixed(0)} fps)`);
console.log(`  p90   ${q(0.9).toFixed(1)} ms   (${(1000 / q(0.9)).toFixed(0)} fps)`);
console.log(`  p95   ${q(0.95).toFixed(1)} ms`);
console.log(`  p99   ${q(0.99).toFixed(1)} ms`);
console.log(`  max   ${s[s.length - 1].toFixed(1)} ms`);
console.log(`  mean  ${mean.toFixed(1)} ms   (${(1000 / mean).toFixed(0)} fps)`);
console.log(`\n  frames > 16.7ms (missed 60): ${over(16.7)}  (${((over(16.7) / s.length) * 100).toFixed(1)}%)`);
console.log(`  frames > 33.3ms (missed 30): ${over(33.3)}  (${((over(33.3) / s.length) * 100).toFixed(1)}%)`);
console.log(`  frames > 50ms   (visible)  : ${over(50)}`);
console.log(`  frames > 100ms  (a stall)  : ${over(100)}`);

if (out.slow.length) {
  console.log('\nslow frames (>40 ms), with engine attribution:');
  const bySys = new Map();
  for (const x of out.slow) {
    const worst = Object.entries(x.sys).sort((a, c) => c[1] - a[1])[0] ?? ['-', 0];
    const key = `${worst[0]} ${worst[1]}`;
    bySys.set(key, (bySys.get(key) ?? 0) + 1);
  }
  for (const x of out.slow.slice(0, 25)) {
    const bits = Object.entries(x.sys).sort((a, c) => c[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
    const alloc = [x.dProg ? `+${x.dProg} prog` : '', x.dGeo ? `+${x.dGeo} geo` : '', x.dTex ? `+${x.dTex} tex` : ''].filter(Boolean).join(' ');
    console.log(`  t=${String(x.at).padStart(5)}ms f${String(x.frame).padStart(5)}  ${String(x.dt).padStart(7)} ms  ${bits}${alloc ? '  [' + alloc + ']' : ''}`);
    for (const f of x.fresh ?? []) {
      console.log(`        NEW PROGRAM "${f.name}"  differs by: ${f.diff || '(no same-named key to diff against)'}`);
      console.log(`          key: ${f.key}`);
    }
    for (const g of x.newGeo ?? []) console.log(`        NEW MESH ${g}`);
  }
  console.log('\n  dominant system across slow frames:');
  for (const [k, n] of [...bySys].sort((a, c) => c[1] - a[1]).slice(0, 8)) console.log(`    ${n}x  ${k}`);
}
