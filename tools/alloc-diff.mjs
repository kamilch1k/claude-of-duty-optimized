/**
 * WHICH meshes upload geometry or textures for the first time during play.
 *
 * three's `info.memory` counters tick when a resource is first bound for a draw,
 * so "+9 geometries" means nine objects were drawn for the very first time on
 * that frame — a lazy allocation, and on the reporter's machine those frames ran
 * 200-1000 ms. Counts and uuids are CPU-side bookkeeping, identical on any GPU.
 *
 * Attribution works by walking both scenes each frame and reporting the mesh
 * whose geometry/material uuid was not present before, which names the culprit
 * instead of leaving the count to be guessed at.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?map=street&menu=0';
const SECONDS = Number(process.argv[3] ?? 30);

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
const SETTLE = Number(process.argv[4] ?? 2000);
await p.waitForTimeout(SETTLE);

const events = await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const info = e.ctx.get('render').renderer.info;
      const inp = e.ctx.input;
      const out = [];
      const seenGeo = new Set();
      const seenTex = new Set();

      const sweep = (collect) => {
        for (const root of [e.ctx.scene, e.ctx.viewScene]) {
          root.traverse((o) => {
            if (!o.isMesh && !o.isPoints && !o.isLine) return;
            if (o.visible === false) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            if (o.geometry && !seenGeo.has(o.geometry.uuid)) {
              if (collect) out.push({ kind: 'geometry', name: o.name || o.type, t: null });
              seenGeo.add(o.geometry.uuid);
            }
            for (const m of mats) {
              if (!m) continue;
              for (const slot of ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
                const tex = m[slot];
                if (tex && !seenTex.has(tex.uuid)) {
                  if (collect) out.push({ kind: `texture:${slot}`, name: o.name || m.name || o.type });
                  seenTex.add(tex.uuid);
                }
              }
            }
          });
        }
      };

      sweep(false); // baseline, silent
      let prev = { g: info.memory.geometries, t: info.memory.textures };
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
        inp._rawLook.x += 4;

        const g = info.memory.geometries;
        const tx = info.memory.textures;
        if (g !== prev.g || tx !== prev.t) {
          const before = out.length;
          sweep(true);
          const names = out.slice(before).map((x) => `${x.kind} ${x.name}`);
          out.length = before;
          out.push({
            t: Math.round(t),
            frame: e.time.frame,
            dg: g - prev.g,
            dt: tx - prev.t,
            names: [...new Set(names)].slice(0, 6),
          });
          prev = { g, t: tx };
        }

        if (t > secs * 1000) {
          if (held) inp._pendingUp.add(held);
          inp._pendingUp.add('Mouse0');
          done(out.filter((x) => x.t !== undefined && x.frame !== undefined));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);

if (!events.length) {
  console.log(`no geometry/texture allocation in ${SECONDS}s of play`);
} else {
  for (const ev of events) {
    const d = [ev.dg ? `+${ev.dg} geo` : '', ev.dt ? `+${ev.dt} tex` : ''].filter(Boolean).join(' ');
    console.log(`${String(ev.t).padStart(6)}ms (frame ${ev.frame})  ${d.padEnd(18)} ${ev.names.join(' | ')}`);
  }
  const geo = events.reduce((a, x) => a + x.dg, 0);
  const tex = events.reduce((a, x) => a + x.dt, 0);
  console.log(`\n${events.length} allocating frames, +${geo} geometries, +${tex} textures total`);
}
await b.close();
