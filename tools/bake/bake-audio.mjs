#!/usr/bin/env node
/**
 * Bake the procedural audio into WAV files for Unity.
 *
 * Upstream there are no sound files: every gunshot, footstep and bark is a Web
 * Audio graph built at play time. Unity cannot run that graph, so each event is
 * rendered offline here and written as 16-bit PCM.
 *
 * One-shots come out dry — Unity spatialises and reverbs them — and the reverb
 * impulses are baked as their own files for Unity's reverb to convolve with.
 * Every take is seeded, so re-running reproduces the same sounds.
 *
 *   node tools/bake/bake-audio.mjs --out=<dir>
 *   node tools/bake/bake-audio.mjs --only=weapon_rifle_1p,impact_concrete
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, withHarness, open, interestingLogs, ROOT } from './lib/harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5293);
const OUT = resolve(args.out ?? resolve(ROOT, '../claude-of-duty-unity/Assets/Art/Audio'));
const ONLY = args.only ? String(args.only).split(',') : null;

const log = (...a) => console.log(...a);

const run = (software) =>
  withHarness(
    PORT,
    async ({ page, logs }) => {
      await open(page, PORT, '/tools/bake/pages/audio.html');
      const list = await page.evaluate('window.__BAKE__.list()');
      log(`audio: ${list.oneShots.length} one-shots + ${list.irs.length} impulses -> ${OUT}`);

      const wanted = ONLY ? list.oneShots.filter((r) => ONLY.includes(r.name)) : list.oneShots;
      const report = { out: OUT, ok: [], failed: [], totalSeconds: 0 };
      mkdirSync(OUT, { recursive: true });

      const write = (baked) => {
        const path = join(OUT, `${baked.name}.wav`);
        const buf = Buffer.from(baked.wav, 'base64');
        writeFileSync(path, buf);
        report.totalSeconds += baked.seconds;
        return buf.length;
      };

      for (let i = 0; i < list.oneShots.length; i++) {
        const recipe = list.oneShots[i];
        if (!wanted.includes(recipe)) continue;
        const t0 = Date.now();
        try {
          const baked = await page.evaluate((index) => window.__BAKE__.bakeOne(index), i);
          const bytes = write(baked);
          report.ok.push({ name: baked.name, bus: baked.bus, seconds: baked.seconds, kb: +(bytes / 1024).toFixed(1), ...baked.stats });
          if (baked.stats.peak === 0) {
            report.failed.push({ name: baked.name, error: 'silent' });
            log(`  SILENT ${baked.name}`);
          }
        } catch (err) {
          report.failed.push({ name: recipe.name, error: String(err.message ?? err) });
          log(`  FAIL ${recipe.name} — ${err.message ?? err}`);
        }
      }
      log(`  one-shots: ${report.ok.length} written, ${report.failed.length} failed`);

      for (const space of list.irs) {
        if (ONLY && !ONLY.includes(`ir_${space}`)) continue;
        try {
          const baked = await page.evaluate((s) => window.__BAKE__.bakeIr(s), space);
          const bytes = write(baked);
          report.ok.push({ name: baked.name, bus: 'reverb', seconds: baked.seconds, kb: +(bytes / 1024).toFixed(1), ...baked.stats });
          log(`  ir ${space.padEnd(8)} ${baked.seconds}s ${(bytes / 1024).toFixed(0)}KB peak ${baked.stats.peak}`);
        } catch (err) {
          report.failed.push({ name: `ir_${space}`, error: String(err.message ?? err) });
          log(`  FAIL ir_${space} — ${err.message ?? err}`);
        }
      }

      report.logs = interestingLogs(logs, 12);
      return report;
    },
    { software, width: 512, height: 512, extraArgs: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] }
  );

let report;
try {
  report = await run(!!args.software);
} catch (err) {
  console.error('bake failed:', err.message ?? err);
  process.exit(1);
}

writeFileSync(resolve(OUT, 'audio.index.json'), JSON.stringify(report, null, 2));
const loudest = report.ok.reduce((a, b) => (b.peak > (a?.peak ?? 0) ? b : a), null);
log(`\naudio: ${report.ok.length} ok, ${report.failed.length} failed, ${report.totalSeconds.toFixed(1)}s of audio`);
if (loudest) log(`loudest: ${loudest.name} peak ${loudest.peak}`);
for (const l of report.logs) log(' ', l);
process.exit(report.failed.length ? 1 : 0);
