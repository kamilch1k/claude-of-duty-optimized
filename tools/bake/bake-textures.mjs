#!/usr/bin/env node
/**
 * Bake the procedural material library into real PNG textures for Unity.
 *
 * Every surface in this game is a fragment shader rendered into three render
 * targets at boot. Nothing is ever read back, because the render targets *are*
 * the textures. Unity cannot sample a Three.js RenderTarget, so this bakes each
 * one to disk — albedo, height, tangent normal, and an ORM packed the way
 * URP/Lit wants it — plus a sidecar with the numbers the material needs to be
 * rebuilt (metres per tile, relief depth, material params).
 *
 *   node tools/bake/bake-textures.mjs --out=<dir> --size=1024
 *   node tools/bake/bake-textures.mjs --only=concrete,brick --weapon=0
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, withHarness, open, interestingLogs, ROOT } from './lib/harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5291);
const SIZE = Number(args.size ?? 1024);
const OUT = resolve(args.out ?? resolve(ROOT, '../claude-of-duty-unity/Assets/Art/Textures'));
const WANT_LIB = args.lib !== '0';
const WANT_WEAPON = args.weapon !== '0';
const ONLY = args.only ? String(args.only).split(',') : null;

const log = (...a) => console.log(...a);

function writeSet(set, dir) {
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const [map, b64] of Object.entries(set.maps ?? {})) {
    const name = `${set.key}_${map}.png`;
    const buf = Buffer.from(b64, 'base64');
    writeFileSync(join(dir, name), buf);
    files[map] = { file: name, bytes: buf.length };
  }
  const sidecar = {
    key: set.key,
    kind: set.kind,
    source: set.source,
    size: set.size,
    worldSize: set.worldSize,
    relief: set.relief,
    alphaMask: set.alphaMask,
    /** Metres of world space covered by one tile of this texture. */
    metresPerTile: set.worldSize ?? null,
    tilesPerMetre: set.worldSize ? 1 / set.worldSize : null,
    params: set.params ?? null,
    files,
  };
  writeFileSync(join(dir, `${set.key}.bake.json`), JSON.stringify(sidecar, null, 2));
  return { files, sidecar };
}

const run = (software) =>
  withHarness(
    PORT,
    async ({ page, logs }) => {
      await open(page, PORT, '/tools/bake/pages/textures.html');
      const gpu = await page.evaluate('window.__BAKE__.gpu');
      const keys = await page.evaluate('window.__BAKE__.keys()');
      const wanted = [];
      if (WANT_LIB) for (const k of keys.library) wanted.push(['library', k]);
      if (WANT_WEAPON) for (const k of keys.weapon) wanted.push(['weapon', k]);
      const queue = ONLY
        ? wanted.filter(([kind, k]) => ONLY.includes(k) || ONLY.includes(`${kind}:${k}`))
        : wanted;

      log(`gpu        : ${gpu.renderer}`);
      log(`textures   : ${queue.length} sets @ ${SIZE}px -> ${OUT}`);
      if (args.dry) return { gpu, sets: queue.map(([kind, k]) => `${kind}:${k}`), dry: true };

      const report = { gpu, size: SIZE, out: OUT, ok: [], failed: [] };
      let bytes = 0;
      for (const [kind, key] of queue) {
        const t0 = Date.now();
        try {
          const set = await page.evaluate(
            ([k, n, s]) => window.__BAKE__.readKey(k, n, s),
            [kind, key, SIZE]
          );
          const dir = resolve(OUT, kind, key);
          const { sidecar } = writeSet(set, dir);
          const mb = Object.values(sidecar.files).reduce((a, f) => a + f.bytes, 0) / 1e6;
          bytes += mb * 1e6;
          report.ok.push({ id: `${kind}:${key}`, maps: Object.keys(sidecar.files).length, mb: +mb.toFixed(2) });
          log(
            `  ok  ${`${kind}:${key}`.padEnd(28)} ${String(Object.keys(sidecar.files).length)} maps` +
              ` ${mb.toFixed(1)}MB ${Date.now() - t0}ms`
          );
        } catch (err) {
          report.failed.push({ id: `${kind}:${key}`, error: String(err.message ?? err) });
          log(`  FAIL ${kind}:${key} — ${err.message ?? err}`);
        }
      }
      report.totalMB = +(bytes / 1e6).toFixed(1);
      report.logs = interestingLogs(logs, 12);
      return report;
    },
    { software, width: 512, height: 512 }
  );

let report;
try {
  report = await run(!!args.software);
} catch (err) {
  console.error('bake failed:', err.message ?? err);
  process.exit(1);
}

if (!report.dry) {
  writeFileSync(resolve(OUT, 'textures.index.json'), JSON.stringify(report, null, 2));
  log(`\ntextures: ${report.ok.length} ok, ${report.failed.length} failed, ${report.totalMB}MB`);
  for (const l of report.logs) log(' ', l);
}
process.exit(report.failed?.length ? 1 : 0);
