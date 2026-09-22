#!/usr/bin/env node
/**
 * Bake the soldier variants for Unity.
 *
 *   node tools/bake/bake-soldiers.mjs
 *   node tools/bake/bake-soldiers.mjs --only=vanguard
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, withHarness, open, interestingLogs, ROOT } from './lib/harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5295);
const OUT = resolve(args.out ?? resolve(ROOT, '../claude-of-duty-unity/Assets/Art/Models/soldiers'));
const ONLY = args.only ? String(args.only).split(',') : null;

const run = (software) =>
  withHarness(
    PORT,
    async ({ page, logs }) => {
      await open(page, PORT, '/tools/bake/pages/soldiers.html');
      const variants = await page.evaluate('window.__BAKE__.variants()');
      const queue = ONLY ? variants.filter((v) => ONLY.includes(v)) : variants;
      console.log(`soldiers: ${queue.join(', ')} -> ${OUT}`);
      const report = { out: OUT, ok: [], failed: [] };
      mkdirSync(OUT, { recursive: true });

      for (const id of queue) {
        try {
          const baked = await page.evaluate((v) => window.__BAKE__.bakeSoldier(v), id);
          const dir = resolve(OUT, id);
          mkdirSync(dir, { recursive: true });
          const bin = Buffer.from(baked.bin, 'base64');
          writeFileSync(join(dir, `${id}.codm.bytes`), bin);
          writeFileSync(join(dir, `${id}.codm.json`), JSON.stringify(baked.manifest, null, 2));
          report.ok.push({ id, tris: baked.tris, meshes: baked.meshes, slots: baked.slots, mb: +(bin.length / 1e6).toFixed(2) });
          console.log(`  ok  ${id.padEnd(12)} ${baked.tris} tris  ${baked.meshes} groups  ${baked.slots} slots  ${(bin.length / 1e6).toFixed(2)}MB`);
        } catch (err) {
          report.failed.push({ id, error: String(err.message ?? err) });
          console.log(`  FAIL ${id} — ${err.message ?? err}`);
        }
      }
      report.logs = interestingLogs(logs, 10);
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
writeFileSync(resolve(OUT, 'soldiers.index.json'), JSON.stringify(report, null, 2));
for (const l of report.logs) console.log(' ', l);
process.exit(report.failed.length ? 1 : 0);
