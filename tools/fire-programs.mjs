/** Name every shader program that compiles while the trigger is held. */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?map=street&menu=0';
const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 240000 });
await p.waitForTimeout(1500);

const log = await p.evaluate(
  () =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const info = e.ctx.get('render').renderer.info;
      const inp = e.ctx.input;
      const key = (x) => `${x.name}`;
      const seen = new Set((info.programs ?? []).map(key));
      const out = [];
      let i = 0;
      const tick = () => {
        if (i === 10) inp._pendingDown.add('Mouse0');
        if (i === 120) inp._pendingUp.add('Mouse0');
        const fresh = (info.programs ?? []).map(key).filter((n) => !seen.has(n));
        if (fresh.length) {
          for (const n of fresh) seen.add(n);
          out.push({ frame: i, fresh });
        }
        if (++i >= 170) {
          done(out);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })
);

console.log(log.length ? JSON.stringify(log, null, 1) : 'no new programs while firing');
await b.close();
