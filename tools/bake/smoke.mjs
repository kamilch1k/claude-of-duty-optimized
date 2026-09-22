#!/usr/bin/env node
/**
 * Smoke test for the texture bake path.
 *
 * Proves the one link that does not exist anywhere in the repo: reading the
 * forge's GPU render targets back to the CPU and out to PNG. If this passes,
 * `bake-textures.mjs` is just bookkeeping.
 *
 *   node tools/bake/smoke.mjs --m=concrete,metal_rust --size=512
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { parseArgs, withHarness, open, interestingLogs } from './lib/harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5299);
const SIZE = Number(args.size ?? 512);
const OUT = resolve(args.out ?? resolve(tmpdir(), 'codu-bake-smoke'));
const SURFACES = String(args.m ?? 'concrete,metal_rust,wood').split(',');

/** Per-channel statistics — flat channels mean the readback silently failed. */
function stats(b64) {
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  const n = png.data.length / 4;
  const distinct = [new Set(), new Set(), new Set(), new Set()];
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < png.data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const v = png.data[i + c];
      distinct[c].add(v);
      sum[c] += v;
    }
  }
  return {
    w: png.width,
    h: png.height,
    mean: sum.map((s) => +(s / n).toFixed(1)),
    uniq: distinct.map((s) => s.size),
    flatten: distinct.map((s) => s.size === 1),
  };
}

const run = (software) =>
  withHarness(
    PORT,
    async ({ page, logs }) => {
      await open(page, PORT, '/tools/bake/pages/textures.html');
      const gpu = await page.evaluate('window.__BAKE__.gpu');
      const names = await page.evaluate('window.__BAKE__.names()');
      const report = { gpu, library: names.length, surfaces: {} };

      for (const name of SURFACES) {
        const t0 = Date.now();
        const baked = await page.evaluate(
          ([n, s]) => window.__BAKE__.read(n, s),
          [name, SIZE]
        );
        const dir = resolve(OUT, name);
        mkdirSync(dir, { recursive: true });
        const maps = {};
        for (const [map, b64] of Object.entries(baked.maps)) {
          writeFileSync(resolve(dir, `${name}_${map}.png`), Buffer.from(b64, 'base64'));
          maps[map] = stats(b64);
        }
        report.surfaces[name] = {
          ms: Date.now() - t0,
          size: baked.size,
          worldSize: baked.worldSize,
          relief: baked.relief,
          alphaMask: baked.alphaMask,
          maps,
        };
      }
      report.logs = interestingLogs(logs, 10);
      return report;
    },
    { software }
  );

let report;
let software = !!args.software;
try {
  report = await run(software);
} catch (err) {
  if (software) throw err;
  console.warn(`GPU path failed (${err.message}) — retrying on SwiftShader`);
  software = true;
  report = await run(true);
}

console.log(JSON.stringify(report, null, 2));

/**
 * Not every flat channel is a bug. Alpha is deliberately forced opaque on the
 * RGB maps, concrete really does have zero metalness, and the URP mask map's
 * blue is reserved. What must never be flat is the content that carries the
 * surface: albedo colour, the height field, and the normal's R/G slope.
 */
const MUST_VARY = [
  ['albedo', 0],
  ['albedo', 1],
  ['albedo', 2],
  ['height', 0],
  ['normal', 0],
  ['normal', 1],
];

let bad = 0;
for (const [name, s] of Object.entries(report.surfaces)) {
  for (const [map, c] of MUST_VARY) {
    const m = s.maps[map];
    if (!m) {
      console.error(`MISSING map: ${name}.${map}`);
      bad++;
    } else if (m.flatten[c]) {
      console.error(`FLAT channel: ${name}.${map}[${c}]`);
      bad++;
    }
  }
  const orm = s.maps.orm;
  if (!orm || (orm.flatten[0] && orm.flatten[1] && orm.flatten[2])) {
    console.error(`ORM carries no data: ${name}`);
    bad++;
  }
}
console.log(`\nTEXTURE BAKE SMOKE: ${bad === 0 ? 'PASS' : `FAIL (${bad} flat channels)`}`);
console.log(`renderer: ${software ? 'swiftshader' : 'gpu'} | out: ${OUT}`);
process.exit(bad === 0 ? 0 : 1);
