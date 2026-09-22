import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';
import { showMainMenu, showLoading, MAPS } from './ui/mainmenu.js';
import { portal } from './core/portal.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

/**
 * FRONT END FIRST, ENGINE SECOND.
 *
 * Nothing 3D is constructed until the player has picked a map. The menu is DOM
 * and paints on the browser's first frame; the 12-25 s of procedural generation
 * and shader translation then happens behind a compositor-animated loading
 * screen instead of behind a black canvas.
 *
 * The menu is SKIPPED for `?capture=1` (the pixel harness drives boot itself),
 * whenever `?map=` names a level outright (so every tool, probe and deep link
 * still boots straight into the game), and for `?menu=0`.
 */
/**
 * Attach the games-portal SDK before the menu, not after.
 *
 * Yandex and CrazyGames both show their own loading screen until the game says
 * it is ready, and both want that call as early as the game is genuinely
 * playable — which here is the main menu, not the first rendered frame of a
 * map. Awaiting it costs nothing off-portal (`init` returns immediately when no
 * portal is configured) and is capped by a timeout on-portal, so a slow SDK can
 * never be the reason the game does not start.
 */
await portal.init();

const skipMenu = capture || params.has('map') || params.get('menu') === '0';
const choice = skipMenu
  ? { map: params.get('map') ?? 'street', mode: params.get('mode') ?? 'tdm' }
  : await showMainMenu({ map: params.get('map'), mode: params.get('mode') });

// Put the loading screen up and let it actually paint before anything blocks:
// engine.init() holds the main thread, so a frame has to land first or the
// overlay never appears.
//
// Shown on the deep-link path too. `?map=` is how every tool, probe and deep
// link boots, and without an overlay that path is a BLACK SCREEN for the whole
// build — 12-25 s of nothing, which reads as a hung tab. Not shown for
// `capture`: the harness compares pixels, and an overlay with a running CSS
// animation in frame is precisely the nondeterminism baseline.mjs exists to
// eliminate.
const loading = capture ? null : showLoading(MAPS.find((m) => m.id === choice.map)?.name ?? choice.map);
if (loading) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

const config = createConfig({
  // Keep the launch path friendly to browser portals. Use ?q=ultra when
  // comparing the full desktop-quality renderer.
  quality: params.get('q') ?? 'low',
  map: choice.map,
  mode: choice.mode,
  // ?skin= applies a weapon finish at boot — the only way to review one under
  // the real sun, since the weapons preview studio backlights every view.
  skin: params.get('skin') ?? null,
  // Same reason: an attachment can only be judged in the game's own light.
  muzzle: params.get('muzzle') ?? null,
  mag: params.get('mag') ?? null,
  stock: params.get('stock') ?? null,
  optic: params.get('optic') ?? null,
  deterministic: capture,
});

const canvas = document.getElementById('game');

const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// THE OLD CHOICE WAS BETWEEN TWO BAD OUTCOMES, AND NEITHER IS ACCEPTABLE.
//
//   prewarm on   boot 48 s, worst in-play frame   69 ms
//   prewarm off  boot  5 s, worst in-play frame 1005 ms
//
// Blocking pre-warm costs a flat ~20 s of held main thread, which a player does
// not experience as a loading screen but as a dead page: nothing renders, the
// menu does not answer clicks, the tab looks hung. Skipping it keeps boot fast
// and moves that cost into gameplay, as the multi-second compile stall the
// pre-warm exists to remove.
//
// PACED pre-warm removes the trade. It admits one coarse driver job per
// animation frame, so the work lands behind the composited loading screen while
// the page stays responsive, and gameplay starts with every permutation already
// translated by the driver. `transients: 'play'` warms what a player triggers in
// the first seconds of a fight — the FX bursts, the fire/ADS poses, the combat
// HUD — measured with tools/fire-programs.mjs to be exactly the set that
// otherwise compiled on the first trigger pull or the first hit taken.
//
// The capture harness keeps the old blocking, transient-free order: the pixel
// gate compares frames, not boot duration, and a deterministically pumped frame
// count is the whole point of tools/baseline.mjs.
const prewarmParam = params.get('prewarm');
const wantPrewarm = prewarmParam === '1' || (prewarmParam !== '0' && !capture);
const progress = { status: wantPrewarm ? 'running' : 'skipped', progress: 0, map: config.map };
window.__PREWARM__ = progress;

const warmup = wantPrewarm
  ? await prewarm(engine, {
    transients: capture ? false : (params.get('warm') ?? 'play'),
    paced: !capture,
    budgetMs: 4,
    /**
     * REAL FRAMES, not just compiles.
     *
     * `renderer.compileAsync` builds the PROGRAM but touches no buffers: three
     * uploads a geometry and binds a texture on first DRAW, and the program it
     * wants can differ from the one compiled because the patcher's key or the
     * visible light set only settles inside a rendered frame. MEASURED on an
     * RTX 4080 with compiles alone: `csm-depth` + `ow-prepass` compile for
     * 218 ms on the first shadowed frame, and one world material plus ten
     * geometry uploads cost 637 ms at 6.5 s into play — all of it first-draw
     * work that compiling cannot reach.
     *
     * The capture harness keeps this off: it advances subsystem state that core
     * cannot fully restore, so it is not pixel-neutral, and the gate outranks it.
     */
    drawFrames: !capture,
    shadow: !capture,
    onProgress: (value) => {
      progress.progress = value;
      loading?.setProgress?.(value);
    },
  })
  : { ok: false, reason: `off${capture ? ' for capture' : ''} — ?prewarm=1 to force` };
Object.assign(progress, warmup, {
  status: warmup.aborted
    ? 'aborted'
    : wantPrewarm
      ? warmup.ok ? 'done' : 'failed'
      : 'skipped',
  progress: warmup.aborted ? progress.progress : 1,
});
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = progress;

engine.start();
loading?.done();

/**
 * Portal handshake. `loaded()` takes the portal's own loading screen down, and
 * the gameplay bracket has to follow real play rather than the page lifetime —
 * both portals use it for session analytics and Yandex certification checks it.
 */
portal.loaded();
portal.gameplayStart();
engine.events.on('ui:pause', ({ paused }) => {
  if (paused) portal.gameplayStop();
  else portal.gameplayStart();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) portal.gameplayStop();
  else if (!engine.ctx.peek('ui')?.menu?.open) portal.gameplayStart();
});


// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
