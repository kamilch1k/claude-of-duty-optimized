#!/usr/bin/env node
/**
 * Bake a level into a CODM prefab for Unity.
 *
 * The level is built by the game's own world subsystem on a stub context (see
 * the page), so the port gets the real market street rather than a rebuild of
 * it. Geometry is merged per material with instance matrices baked in.
 *
 *   node tools/bake/bake-world.mjs --dry                 # stats only, both maps
 *   node tools/bake/bake-world.mjs --map=street
 *   node tools/bake/bake-world.mjs --map=swat            # greybox CQB, much smaller
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, withHarness, open, interestingLogs, ROOT } from './lib/harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5294);
const OUT = resolve(args.out ?? resolve(ROOT, '../claude-of-duty-unity/Assets/Art/Models/world'));
const MAPS = args.map ? String(args.map).split(',') : ['street', 'swat'];
const DRY = !!args.dry;

const log = (...a) => console.log(...a);

const run = (software) =>
  withHarness(
    PORT,
    async ({ page, logs }) => {
      await open(page, PORT, '/tools/bake/pages/world.html');
      const report = { out: OUT, ok: [], failed: [] };

      for (const map of MAPS) {
        const t0 = Date.now();
        try {
          const baked = await page.evaluate(
            ([m, dry]) => window.__BAKE__.bakeWorld(m, { maxTris: dry ? 1 : 0 }),
            [map, DRY]
          );
          const stats = {
            map,
            tris: baked.tris,
            parts: baked.parts,
            meshes: baked.meshes,
            instances: baked.instances,
            buildMs: Math.round(baked.buildMs),
            ms: Date.now() - t0,
          };
          if (baked.dry) {
            log(`  dry  ${map.padEnd(8)} ${baked.tris.toLocaleString()} tris  ${baked.parts} parts  ${baked.meshes} meshes  ${baked.instances} instances  build ${stats.buildMs}ms`);
          } else {
            const dir = resolve(OUT, map);
            mkdirSync(dir, { recursive: true });
            const bin = Buffer.from(baked.bin, 'base64');
            writeFileSync(join(dir, `${map}.codm.bytes`), bin);
            writeFileSync(join(dir, `${map}.codm.json`), JSON.stringify(baked.manifest, null, 2));
            stats.mb = +(bin.length / 1e6).toFixed(1);
            stats.spawns = baked.manifest.specs.spawnPoints.length;
            log(
              `  ok   ${map.padEnd(8)} ${baked.tris.toLocaleString()} tris  ${baked.parts} parts  ` +
                `${stats.mb}MB  ${stats.spawns} spawns  build ${stats.buildMs}ms`
            );
          }
          report.ok.push(stats);
        } catch (err) {
          report.failed.push({ map, error: String(err.message ?? err) });
          log(`  FAIL ${map} — ${err.message ?? err}`);
        }
      }
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

if (!DRY) writeFileSync(resolve(OUT, 'world.index.json'), JSON.stringify(report, null, 2));
for (const l of report.logs) log(' ', l);
process.exit(report.failed.length ? 1 : 0);
