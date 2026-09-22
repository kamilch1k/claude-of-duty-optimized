/**
 * PROFILE ACTUAL PLAY — moving, turning, shooting — frame by frame.
 *
 * Every other tool here measures a single event (a boot, a spawn). A stutter is
 * not an event, it is a frame that took too long while the player was doing
 * something, so this drives the real input path — WASD held, the view swinging,
 * the trigger down in bursts — and records what every subsystem cost on every
 * one of ~1800 frames.
 *
 * WHAT IS TRUSTWORTHY HERE, since it decides what the output may be used for:
 *
 *   CPU time per system     yes. It is the same JavaScript on the same V8, and
 *                           a system that spikes to 40 ms of scripting spikes
 *                           on real hardware too.
 *   program/geometry/texture
 *   deltas on a given frame yes, and these are the classic stutter: a shader
 *                           compiled the first time you fire is a real stall.
 *   `render` system time    NO. Headless is a software rasteriser with no GPU;
 *                           its draw cost is fiction and is reported separately
 *                           so it never contaminates the CPU ranking.
 *
 *   node tools/playprofile.mjs [frames] [--headed] [--url=...]
 *
 * Headed mode uses the installed Chrome on a real GPU (d3d11 on Windows, metal
 * on macOS) — the only way any draw-cost number means anything.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const cli = process.argv.slice(2);
const FRAMES = Number(cli.find((arg) => /^\d+$/.test(arg)) ?? 1800);
const HEADED = cli.includes('--headed');
const URL_ARG = cli.find((a) => a.startsWith('--url='))?.slice(6)
  ?? 'http://127.0.0.1:5173/?map=street&menu=0';

// Headed on Windows needs a Chrome that can reach the GPU; Playwright's bundled
// chromium is fine, but prefer the installed channel when it exists.
const useChannel = HEADED && existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const b = await chromium.launch({
  ...(HEADED && useChannel ? { channel: 'chrome' } : {}),
  headless: !HEADED,
  args: HEADED
    ? [
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-software-rasterizer',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--mute-audio',
    ]
    : ['--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
p.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});
await p.goto(URL_ARG, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 600000 });
await p.waitForTimeout(3000);

const gpu = await p.evaluate(() => {
  const gl = window.__ENGINE__?.ctx.peek('render')?.renderer?.getContext?.();
  const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
if (HEADED && /swiftshader|software|llvmpipe|warp/i.test(gpu)) {
  await b.close();
  throw new Error(`--headed requested a hardware profile, got ${gpu}`);
}
console.log(`GPU: ${gpu}`);

const out = await p.evaluate(async (frames) => {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const ai = ctx.peek('ai');
  const input = ctx.input;
  const render = ctx.peek('render');
  const player = ctx.peek('player');

  player?.setControlEnabled?.(true);

  /**
   * Hand-pump the engine instead of letting its own rAF loop run.
   *
   * Two loops racing is not a profile: the engine's loop steals the frames this
   * one is timing, and every delta becomes a measurement of scheduler luck. The
   * engine keeps its own loop for the headed, real-GPU run — where the point is
   * exactly to see what a real frame does — but this mode is for CPU attribution
   * and resource deltas, and both need a single deterministic stepper.
   */
  e.stop();

  /**
   * Drive the REAL input path rather than teleporting the camera.
   *
   * Moving the player object directly would skip collision, the character
   * controller, footsteps, the weapon sway and the animation — i.e. most of the
   * per-frame work a stutter could be hiding in. Holding keys and feeding look
   * deltas exercises all of it.
   *
   * `look` is recomputed inside beginFrame from accumulated mouse deltas, so it
   * has to be written AFTER that runs — hence the wrapper rather than a plain
   * assignment before step().
   */
  const script = { lookX: 0, lookY: 0 };
  const realBegin = input.beginFrame.bind(input);
  input.beginFrame = (dt) => {
    realBegin(dt);
    input.look.x = script.lookX;
    input.look.y = script.lookY;
  };

  const samples = [];
  const info = () => {
    const i = render.renderer.info;
    return { tex: i.memory.textures, geo: i.memory.geometries, prog: i.programs?.length ?? 0 };
  };

  /**
   * Attribution, because a count is not a cause.
   *
   * `renderer.info.memory` ticks when a resource is first bound for a draw, so a
   * "+35 textures" frame is either 35 materials drawn for the first time or a
   * pile of render targets being created — and the fix is completely different.
   * Walking both scenes names the first case; if the walk finds nothing, the
   * counter rose for something no scene graph contains.
   */
  const seenGeo = new Set();
  const seenTex = new Set();
  const sweep = (collect) => {
    const found = [];
    for (const root of [ctx.scene, ctx.viewScene]) {
      if (!root) continue;
      root.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isLine) return;
        if (o.visible === false) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (o.geometry && !seenGeo.has(o.geometry.uuid)) {
          if (collect) found.push(`geo ${o.name || o.type}`);
          seenGeo.add(o.geometry.uuid);
        }
        for (const m of mats) {
          if (!m) continue;
          for (const k in m) {
            const v = m[k];
            if (!v || !v.isTexture) continue;
            if (seenTex.has(v.uuid)) continue;
            if (collect) found.push(`tex ${k} ${o.name || m.name || m.type}`);
            seenTex.add(v.uuid);
          }
        }
      });
    }
    return found;
  };
  sweep(false);

  let prev = info();
  let t = performance.now();

  for (let f = 0; f < frames; f++) {
    // ---- scripted play -----------------------------------------------------
    // A lap of the street: the leg changes every ~2 s so the character
    // controller keeps meeting new geometry instead of settling into a corner.
    input.down.delete('KeyW');
    input.down.delete('KeyA');
    input.down.delete('KeyS');
    input.down.delete('KeyD');
    const leg = Math.floor(f / 120) % 4;
    input.down.add(['KeyW', 'KeyD', 'KeyS', 'KeyA'][leg]);
    if (f % 240 < 8) input.down.add('Space');
    else input.down.delete('Space');

    // Sweep the view continuously, with a fast flick every few seconds — a
    // flick is when a shadow cascade or a new bit of level first becomes
    // visible, which is exactly when a lazy compile lands.
    script.lookX = Math.sin(f * 0.01) * 0.9 + (f % 300 < 6 ? 7 : 0);
    script.lookY = Math.sin(f * 0.004) * 0.25;

    // Fire in bursts: 40 frames on, 40 off.
    if (f % 80 < 40) input.down.add('Mouse0');
    else input.down.delete('Mouse0');

    // A firefight, once: AI is the other half of the per-frame cost and the
    // other classic source of first-use resource construction.
    if (f === 60) ai?.debugStage?.('firefight');

    // ---- the measured step -------------------------------------------------
    const t0 = performance.now();
    e.step((t += 16.6));
    const total = performance.now() - t0;

    const now = info();
    const sys = {};
    for (const [k, v] of e._sysMs ?? []) sys[k] = v;
    /** Only the first seconds are interesting for first-use allocation, and the
     *  scene walk is far too expensive to run on every frame. */
    let names = null;
    if (f < 240 && (now.geo !== prev.geo || now.tex !== prev.tex)) {
      names = [...new Set(sweep(true))].slice(0, 10);
    }
    samples.push({
      f,
      total,
      sys,
      dTex: now.tex - prev.tex,
      dGeo: now.geo - prev.geo,
      dProg: now.prog - prev.prog,
      names,
    });
    prev = now;
  }

  return {
    samples,
    finalPos: player?.position ? [player.position.x, player.position.y, player.position.z] : null,
    dead: !!player?.dead,
  };
}, FRAMES);

await b.close();

const s = out.samples;
const pct = (arr, q) => arr.slice().sort((a, c) => a - c)[Math.floor(arr.length * q)] ?? 0;

// Rank systems by CPU cost, render excluded — see the header note.
const names = new Set();
for (const x of s) for (const k of Object.keys(x.sys)) names.add(k);
names.delete('render');

console.log(`${s.length} frames of scripted play (move + look + fire + AI)\n`);
console.log('  system        p50      p95      p99      max     share');
const rows = [];
for (const n of names) {
  const v = s.map((x) => x.sys[n] ?? 0);
  const sum = v.reduce((a, c) => a + c, 0);
  rows.push({ n, p50: pct(v, 0.5), p95: pct(v, 0.95), p99: pct(v, 0.99), max: Math.max(...v), sum });
}
const grand = rows.reduce((a, r) => a + r.sum, 0) || 1;
for (const r of rows.sort((a, c) => c.sum - a.sum).slice(0, 12)) {
  console.log(
    `  ${r.n.padEnd(11)} ${r.p50.toFixed(2).padStart(7)} ${r.p95.toFixed(2).padStart(8)} ` +
      `${r.p99.toFixed(2).padStart(8)} ${r.max.toFixed(1).padStart(8)}   ${((r.sum / grand) * 100).toFixed(1).padStart(5)}%`
  );
}

// The frames that would actually be felt, and what was happening on them.
const cpu = s.map((x) => Object.entries(x.sys).reduce((a, [k, v]) => a + (k === 'render' ? 0 : v), 0));
console.log(`\nCPU per frame (render excluded): p50 ${pct(cpu, 0.5).toFixed(2)} ms  p95 ${pct(cpu, 0.95).toFixed(2)}  p99 ${pct(cpu, 0.99).toFixed(2)}  max ${Math.max(...cpu).toFixed(1)}`);

const ranked = s
  .map((x, i) => ({ ...x, cpu: cpu[i] }))
  .sort((a, c) => c.cpu - a.cpu)
  .slice(0, 12);
console.log('\nworst CPU frames — what dominated, and what was allocated:');
for (const x of ranked) {
  const top = Object.entries(x.sys)
    .filter(([k]) => k !== 'render')
    .sort((a, c) => c[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(', ');
  const alloc = [x.dProg ? `+${x.dProg} prog` : '', x.dTex ? `+${x.dTex} tex` : '', x.dGeo ? `+${x.dGeo} geo` : '']
    .filter(Boolean)
    .join(' ');
  console.log(`  f${String(x.f).padStart(5)}  ${x.cpu.toFixed(1).padStart(6)} ms   ${top}${alloc ? '   [' + alloc + ']' : ''}`);
}

// Any frame that compiled a program is a guaranteed real-hardware stall.
const compiles = s.filter((x) => x.dProg > 0);
console.log(`\nframes that compiled a shader mid-play: ${compiles.length}`);
for (const c of compiles.slice(0, 10)) console.log(`  f${c.f}  +${c.dProg} programs`);

// Any frame that constructed a geometry or uploaded a texture is the other
// classic stall, and it is not visible in the CPU numbers at all.
const allocs = s.filter((x) => x.dGeo > 0 || x.dTex > 0);
console.log(`\nframes that constructed geometry or uploaded a texture: ${allocs.length}`);
for (const a of allocs.slice(0, 12)) {
  const d = [a.dGeo ? `+${a.dGeo} geo` : '', a.dTex ? `+${a.dTex} tex` : ''].filter(Boolean).join(' ');
  const who = a.names?.length ? `\n        ${a.names.join('\n        ')}` : '   (nothing in either scene: render targets or lazy uploads)';
  console.log(`  f${String(a.f).padStart(4)}  ${d}${who}`);
}

console.log(`\nplayer ended at ${out.finalPos?.map((v) => v.toFixed(1)).join(', ')}  dead=${out.dead}`);
if (errors.length) console.log(`page errors (${errors.length}): ${errors.slice(0, 3).join(' | ')}`);
