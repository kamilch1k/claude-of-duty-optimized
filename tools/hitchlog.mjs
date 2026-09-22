/**
 * Play the game for a while and collect every [hitch] the engine reports.
 *
 * The millisecond figures here are NOT trustworthy — headless Chromium has no
 * GPU and software-rasterises, so `render` is inflated and everything else is
 * relative to a CPU that is doing a different job. What IS trustworthy, and the
 * reason this exists, is the attribution: which system ran long, and whether the
 * frame allocated a shader program, a geometry or a texture. Those counts come
 * from renderer.info and are identical on any machine.
 *
 * Read it as "what does the engine do on a bad frame", never as "how slow".
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?map=street&menu=0';
const SECONDS = Number(process.argv[3] ?? 25);

// HEADED=1 runs on the real GPU. Headless software-rasterises, which makes
// `render` fiction and hides exactly the frames this is hunting.
const HEADED = !!process.env.HEADED;
const b = await chromium.launch({
  headless: !HEADED,
  // On a hybrid-graphics laptop the default adapter is the integrated one and
  // every number here becomes a measurement of the wrong GPU.
  ...(HEADED ? { channel: 'chrome' } : {}),
  args: HEADED
    ? ['--mute-audio', '--autoplay-policy=no-user-gesture-required',
       '--use-angle=d3d11', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
       '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
       '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
       '--window-position=0,0', '--window-size=1280,760']
    : ['--mute-audio', '--autoplay-policy=no-user-gesture-required',
       '--window-position=0,0', '--window-size=1280,760'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });

const hitches = [];
p.on('console', (m) => {
  const s = m.text();
  if (s.startsWith('[hitch]')) hitches.push(s);
});
p.on('pageerror', (e) => console.log('[pageerror]', e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(1500);

// Walk a slow circle while firing in bursts, so the run touches movement,
// pathing, combat and effects rather than idling somewhere cheap.
await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const inp = window.__ENGINE__.ctx.input;
      const keys = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
      let held = null;
      const t0 = performance.now();
      const tick = () => {
        const t = performance.now() - t0;
        const want = keys[Math.floor(t / 1200) % 4];
        if (want !== held) {
          if (held) inp._pendingUp.add(held);
          inp._pendingDown.add(want);
          held = want;
        }
        // fire for 400 ms out of every second
        const phase = t % 1000;
        if (phase < 16) inp._pendingDown.add('Mouse0');
        else if (phase > 400 && phase < 416) inp._pendingUp.add('Mouse0');
        // keep turning so new geometry keeps entering the frustum
        inp._rawLook.x += 6;
        if (t > secs * 1000) {
          if (held) inp._pendingUp.add(held);
          inp._pendingUp.add('Mouse0');
          done();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);

console.log(hitches.length ? hitches.join('\n') : `no frame over 24 ms in ${SECONDS}s`);
console.log(`\n${hitches.length} hitches in ${SECONDS}s`);
const gpu = hitches.filter((h) => h.includes('+')).length;
console.log(`${gpu} of them allocated a GPU object on the same frame`);
await b.close();
