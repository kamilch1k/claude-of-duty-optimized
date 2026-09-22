#!/usr/bin/env node
/**
 * Bake the procedural weapon models to GLB for Unity.
 *
 * Each weapon exports as one hierarchy: the receiver body, every attachment
 * variant, the moving parts, and the named nodes the game hangs effects and
 * animation off (`muzzle`, `chamber`, `eject`, the grip points). Attachment
 * stats — magazine capacity, reload multiplier, ADS scale, reticle — ride along
 * in the sidecar because they are gameplay data, not art.
 *
 * A preview PNG is rendered from the exported GLB itself, so the bake is
 * verified against what it wrote rather than against the source.
 *
 *   node tools/bake/bake-meshes.mjs --only=rifle
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, withHarness, open, interestingLogs, ROOT } from './lib/harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5292);
const OUT = resolve(args.out ?? resolve(ROOT, '../claude-of-duty-unity/Assets/Art/Models'));
const PREVIEW = resolve(args.preview ?? resolve(ROOT, 'tools/bake/out/meshes'));
const ONLY = args.only ? String(args.only).split(',') : null;

/** Previews rendered as a set of fixed angles so runs are comparable. */
const SHOTS = {
  side: { yaw: 1.35, pitch: 0.12, zoom: 1.08 },
  quarter: { yaw: 0.72, pitch: 0.34, zoom: 1.06 },
  muzzle: { yaw: 2.55, pitch: 0.18, zoom: 1.02 },
};

/**
 * The shipped loadout, from `Viewmodel.addWeapon` — the preview hides every
 * other variant so the render shows the weapon the game actually draws.
 */
const DEFAULTS = {
  rifle: { optic: 'reddot', muzzle: 'brake', mag: 'std', stock: 'standard' },
  smg: { optic: 'reddot', muzzle: 'trilug', mag: 'std', stock: 'standard' },
  pistol: { optic: 'irons', muzzle: null, mag: 'std', stock: null },
};
const SLOTS = { optics: 'optic', muzzles: 'muzzle', mags: 'mag', stocks: 'stock' };

function hideList(id, parts) {
  const want = DEFAULTS[id] ?? {};
  const hide = [];
  for (const { path, node } of parts) {
    const top = path.split('/')[0];
    const slot = SLOTS[top];
    if (!slot) continue;
    const keep = want[slot];
    if (!keep || !path.startsWith(`${top}/${keep}/`)) hide.push(node);
  }
  return hide;
}

const log = (...a) => console.log(...a);

const run = (software) =>
  withHarness(
    PORT,
    async ({ page, logs }) => {
      await open(page, PORT, '/tools/bake/pages/meshes.html');
      const models = await page.evaluate('window.__BAKE__.models()');
      const queue = ONLY ? models.filter((m) => ONLY.includes(m)) : models;
      log(`models: ${queue.join(', ')} -> ${OUT}`);

      const report = { out: OUT, ok: [], failed: [] };
      for (const id of queue) {
        const t0 = Date.now();
        try {
          const baked = await page.evaluate((m) => window.__BAKE__.bakeModel(m), id);
          const dir = resolve(OUT, id);
          mkdirSync(dir, { recursive: true });
          const glbPath = join(dir, `${id}.glb`);
          writeFileSync(glbPath, Buffer.from(baked.glb, 'base64'));

          // CODM: the copy Unity actually imports (see the page for why).
          const codm = await page.evaluate((m) => window.__BAKE__.bakeCodm(m), id);
          writeFileSync(join(dir, `${id}.codm.bytes`), Buffer.from(codm.bin, 'base64'));
          writeFileSync(join(dir, `${id}.codm.json`), JSON.stringify(codm.manifest, null, 2));
          const sidecar = {
            id: baked.id,
            label: baked.label,
            fxClass: baked.fxClass,
            tris: baked.tris,
            parts: baked.parts,
            specs: baked.specs,
            materialDefs: baked.materialDefs,
            glb: `${id}.glb`,
            glbBytes: baked.bytes,
          };
          writeFileSync(join(dir, `${id}.json`), JSON.stringify(sidecar, null, 2));

          mkdirSync(PREVIEW, { recursive: true });
          const hide = hideList(id, baked.parts);
          const shots = [];
          for (const [name, opts] of Object.entries(SHOTS)) {
            const shot = await page.evaluate(
              ([b64, o]) => window.__BAKE__.render(b64, o),
              [baked.glb, { ...opts, hide }]
            );
            writeFileSync(join(PREVIEW, `${id}_${name}.png`), Buffer.from(shot.png, 'base64'));
            shots.push({ name, objects: shot.objects, bones: shot.bones, materials: shot.materials, bounds: shot.bounds });
          }
          const s = shots[0];
          report.ok.push({
            id,
            tris: baked.tris,
            kb: +(baked.bytes / 1024).toFixed(1),
            parts: baked.parts.length,
            materials: s.materials,
            bounds: s.bounds,
            objects: s.objects,
            ms: Date.now() - t0,
          });
          log(
            `  ok  ${id.padEnd(8)} ${String(baked.tris).padStart(6)} tris  ${(baked.bytes / 1024).toFixed(0)}KB` +
              `  ${baked.parts.length} parts  ${s.materials.length} mats  ${Date.now() - t0}ms`
          );
          log(`      parts: ${baked.parts.map((p) => `${p.path}(${p.tris})`).join(' ')}`);
        } catch (err) {
          report.failed.push({ id, error: String(err.message ?? err) });
          log(`  FAIL ${id} — ${err.message ?? err}`);
        }
      }
      report.logs = interestingLogs(logs, 12);
      return report;
    },
    { software, width: 1024, height: 768 }
  );

let report;
try {
  report = await run(!!args.software);
} catch (err) {
  console.error('bake failed:', err.message ?? err);
  process.exit(1);
}

if (!args.skipIndex) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'models.index.json'), JSON.stringify(report, null, 2));
}
log(`\nmeshes: ${report.ok.length} ok, ${report.failed.length} failed | previews: ${PREVIEW}`);
for (const l of report.logs) log(' ', l);
process.exit(report.failed.length ? 1 : 0);
