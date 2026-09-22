/**
 * Shader pre-warm.
 *
 * WHY THIS EXISTS — measured, not guessed. Profiling actual gameplay at Retina
 * DPR showed 86 WebGL programs compiling lazily *during play*, with up to 30
 * landing on a single frame. Each of those frames took 3.1-3.9 SECONDS. That is
 * the "freezing" players report: not a low frame rate, but multi-second stalls
 * whenever geometry with an uncompiled material/light/shadow permutation first
 * enters the frame.
 *
 * Three.js compiles a program the first time a given (material, lights, shadow,
 * skinning, fog, ...) permutation is actually drawn. The fix is to force every
 * permutation to compile up front, while a loading state is on screen, so the
 * steady-state frame loop never compiles anything.
 *
 * This must not change a single rendered pixel. It only moves *when* compilation
 * happens, so it touches no material parameters, no camera, no lighting state.
 * The pixel-diff gate (tools/imagediff.mjs) enforces that.
 *
 * Two mechanisms, because neither alone is sufficient:
 *
 *  1. renderer.compileAsync() — uses KHR_parallel_shader_compile where available,
 *     so it compiles off the main thread and does not block. Covers the forward
 *     lit pass for everything currently in a scene graph.
 *  2. Real frames from representative poses — compileAsync does NOT cover the
 *     depth/shadow-map variant of a material, nor the post-processing chain,
 *     nor permutations that only exist once a subsystem has spawned its transient
 *     objects (particles, decals, ragdolls, muzzle flash). Actually drawing a
 *     handful of frames is the only way to reach those.
 */

/** Poses chosen to span the level's lighting and material variety, so the
 *  cascades, interiors and exteriors all get their permutations compiled. */
const WARM_POSES = [
  { pos: [12, 1.75, 18], look: [-4, 2.2, -6] }, // main street, long cascades
  { pos: [-8.5, 1.7, 3.2], look: [2, 1.6, -2] }, // interior, short cascades
  { pos: [3.2, 1.35, 5.0], look: [1.4, 1.1, 2.2] }, // close material detail
  { pos: [4, 1.7, 12], look: [-6, 1.7, -4] }, // combat staging
];

/**
 * Force every shader permutation to compile, either eagerly during boot or in
 * paced chunks after the interactive UI is available.
 * Resolves once warm. Never throws — a failed pre-warm must not block boot,
 * it just means the old stutter comes back.
 */
/**
 * @param opts.transients  Stage each subsystem's spawned objects (enemies, impact
 *   bursts, muzzle flash) so their programs compile too. MEASURED TO BE UNSAFE and
 *   therefore off by default: the pixel-diff gate showed up-to-254/255 channel
 *   deltas afterwards, because decals live in a persistent ring buffer and spawned
 *   actors are not despawned by any hook reachable from here. Reaching the
 *   remaining permutations safely needs a `prewarmMaterials()` on each subsystem
 *   that builds and compiles its materials WITHOUT spawning gameplay objects —
 *   which is owned by those subsystems, not by core.
 */
import * as THREE from 'three';

/**
 * Subsystems whose `prewarmMaterials()` must NOT be driven from here.
 *
 * `fx` self-schedules its own pre-warm on the second rendered frame, and that is
 * not a workaround it can drop: the program cache key carries the number of
 * VISIBLE lights, and the visible set is only settled inside the renderer's
 * first frame (`render._cullLights`) plus `world._stabiliseLightCount`, both of
 * which run after this function has returned. Calling fx from here would compile
 * a permutation the frame loop never asks for AND latch fx's `_warmed` flag, so
 * the real programs would go back to compiling on the first shot fired. Measured
 * by src/fx: that is 12 programs / 142-159 ms on the frame the trigger is pulled.
 */
const SELF_WARMING = new Set(['fx']);

/**
 * Whether to let `render.prewarmMaterials()` run its CSM-depth + MRT-prepass step.
 *
 * OFF, and it is the one thing in this file that was MEASURED not to be
 * pixel-neutral. Unlike every other step here, that one does not compile — it
 * actually *runs* the two depth passes, writing the shadow array and the gbuffer.
 * `render` reports it as clean when invoked standalone at frame 0; driven from
 * here (after every subsystem has init'd, with the camera restored to the real
 * spawn pose) it is not. Bisected against shots/perf-base with everything else in
 * place, one variable at a time:
 *
 *   render-only tree, no hooks .................. identical, 0 px
 *   + ragdoll sleep skip ........................ identical, 0 px
 *   + all hooks, shadow:false ................... identical, 0 px
 *   + all hooks, shadow:true .... detail/impacts/muzzle/night/weapon changed,
 *                                 0.005-0.017% of pixels, maxDelta 1
 *
 * Run-to-run noise was verified at exactly zero first (two captures of the same
 * tree were bit-identical), so those deltas are the change, not the harness.
 *
 * Little is lost: the override-material variants are reached anyway, without
 * drawing, by `world.prewarmMaterials()` (which compiles the level under
 * `csm.depthMaterial` and `gbuffer.material` via `scene.overrideMaterial`) and by
 * `ai.prewarmMaterials()` (which borrows render's depth override for the
 * characters). The gate outranks the last few programs.
 */
const RENDER_SHADOW_WARM = false;

/**
 * PACING IS A LOAD-TIME LEVER, NOT A STUTTER FIX. The `paced` option below can
 * keep the UI responsive while this work finishes, but an earlier incremental
 * pre-warm was measured not to fix the remaining gameplay hitch by itself.
 *
 * Instrumenting the worst frame of a 1200-frame camera sweep on the street map:
 *
 *   frame 239, 801 ms, +2 programs, +6 TEXTURES, +6 GEOMETRIES, at t=1.8 s
 *
 * Six geometries and six textures being CONSTRUCTED on one frame, 1.8 seconds
 * into play, is lazy resource creation by a subsystem on first use — not
 * translation of a program that already exists. Warming programs in the
 * background moved nothing: worst frame 823 ms before, 804-1035 ms after, while
 * costing ~20 s of driver work and ~15 extra programs the game never asks for.
 *
 * The next step is to find the allocator, not to compile harder. Prime suspects
 * are `fx` (its self-warm is documented to land around the first shot) and `ai`
 * (first-use variant geometry and ground-shadow targets). Whoever it is should
 * build those resources during init like `world` and `ai` already do for nav.
 */

/**
 * @param {object} engine
 * @param {object} [opts]
 * @param {boolean|object} [opts.paced=false] one coarse driver job per rAF; an
 *   object may contain `budgetMs` and `signal`
 * @param {number} [opts.budgetMs=4] best-effort point after which a late rAF is
 *   skipped rather than starting another non-preemptible driver job
 * @param {AbortSignal} [opts.signal] cancellation checked between coarse jobs
 * @param {boolean} [opts.shadow=RENDER_SHADOW_WARM] run render's CSM-depth and
 *   MRT-prepass warm. OFF for the capture harness, which needs bit-identical
 *   frames (this step measures 0.005-0.017% of pixels moving by 1/255); ON for
 *   play, where MEASURED on an RTX 4080 it is the difference between a 213 ms
 *   `csm-depth`+`ow-prepass` compile on the first shadowed frame and none.
 */
export async function prewarm(engine, {
  onProgress = () => {},
  transients = false,
  drawFrames = false,
  paced = false,
  budgetMs = 4,
  signal,
  shadow = RENDER_SHADOW_WARM,
} = {}) {
  const t0 = performance.now();
  const render = engine.ctx.peek('render');
  const renderer = render?.renderer;
  if (!renderer) return { ok: false, reason: 'no renderer' };

  // A shader compile/draw cannot be interrupted once it has entered the driver,
  // so the budget is necessarily best-effort. In paced mode each coarse job is
  // admitted by a separate rAF; if the callback itself did not arrive until the
  // frame's budget was already spent, wait for one more frame before starting.
  // The object form is handy for callers that want to keep all pacing controls
  // together, while `paced: true, budgetMs, signal` remains the simple API.
  const paceOpts = paced && typeof paced === 'object' ? paced : null;
  const isPaced = paced === true || !!paceOpts;
  const paceSignal = signal ?? paceOpts?.signal;
  const requestedBudget = paceOpts?.budgetMs ?? budgetMs;
  const frameBudget = Number.isFinite(Number(requestedBudget))
    ? Math.max(0, Number(requestedBudget))
    : 4;

  const abortError = () => {
    const err = new Error('Shader pre-warm aborted');
    err.name = 'AbortError';
    return err;
  };
  const checkAbort = () => {
    if (paceSignal?.aborted) throw abortError();
  };
  const waitFrame = () => new Promise((resolve, reject) => {
    if (paceSignal?.aborted) {
      reject(abortError());
      return;
    }
    let raf = 0;
    const onAbort = () => {
      cancelAnimationFrame(raf);
      reject(abortError());
    };
    raf = requestAnimationFrame((frameTime) => {
      paceSignal?.removeEventListener?.('abort', onAbort);
      resolve(frameTime);
    });
    paceSignal?.addEventListener?.('abort', onAbort, { once: true });
  });
  const beforeJob = isPaced
    ? async () => {
      let frameTime = await waitFrame();
      checkAbort();
      if (frameBudget > 0 && performance.now() - frameTime >= frameBudget) {
        frameTime = await waitFrame();
        checkAbort();
      }
      return frameTime;
    }
    : null;

  const programsBefore = renderer.info.programs?.length ?? 0;
  const cam = engine.camera;
  const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };

  /**
   * Put the scene lights in the exact state RenderSystem submits to Three.
   *
   * Boot leaves the fallback sun visible and only the authored point lights
   * visible. Compiling in that state creates a 3-directional/4-point program
   * set; WorldSystem then pads to 20 points and creates the same set again;
   * the first real render finally hides the fallback sun and uses 2/20. Those
   * first two sets can never be requested by gameplay. Mirror the frame's
   * ordering before every forward compile so all warmers share the live key.
   */
  const warmCamPos = new THREE.Vector3();
  const normaliseLightPermutation = () => {
    engine.ctx.peek('world')?._stabiliseLightCount?.(engine.ctx);
    render._collect?.(engine.scene);
    render._syncSun?.(cam);
    cam.getWorldPosition(warmCamPos);
    render._cullLights?.(warmCamPos);
  };

  // Pre-warm has to be *simulation-transparent*, not just visually transparent.
  // It steps the engine, which advances the clock and the RNG stream; if that
  // residue survived, every downstream capture would drift and the pixel-diff
  // gate would report phantom regressions. Snapshot and restore both.
  const t = engine.time;
  const savedTime = { elapsed: t.elapsed, raw: t.raw, dt: t.dt, alpha: t.alpha, frame: t.frame };
  const r = engine.rng;
  const savedRng = { s0: r.s0, s1: r.s1, s2: r.s2, s3: r.s3, spare: r._spare };
  const savedAccum = engine._accum;

  // Subsystems whose materials only exist once they have spawned something.
  // These are the public debug hooks ARCHITECTURE.md already defines for the
  // capture harness; using them here costs nothing and reaches the transient
  // material permutations (particles, decals, ragdolls, flash, HUD layers).
  // Only kinds the subsystems actually implement — verified by reading their
  // sources, not guessed. fx.debugBurst understands 'explosion' | 'muzzle' |
  // 'combat' and a default wall burst; anything else falls through to the same
  // default, so enumerating surface names buys nothing. weapons.debugPose
  // understands 'idle' | 'ads' | 'fire'.
  /**
   * Named so the caller can take a SUBSET. Warming all of them is correct and
   * costs 20-48 s of blocked main thread — the whole reason this pass was off by
   * default. But only two of them matter for the stutter a player actually
   * feels, measured with tools/fire-programs.mjs: `muzzle` builds `fx-distort`
   * and `fx-haze-warp`, `lowhealth` builds `player:lowhealth`. Those three were
   * the only programs compiling during play, so `'lite'` warms exactly them and
   * skips the expensive rest.
   */
  const transientStages = (() => {

    const fxOff = () => engine.ctx.peek('fx')?.debugBurst?.('none');
    return [
    { id: 'ai', run: () => engine.ctx.peek('ai')?.debugStage?.('firefight'),
      reset: () => engine.ctx.peek('ai')?.debugStage?.('none') },
    { id: 'wall', run: () => engine.ctx.peek('fx')?.debugBurst?.('wall'), reset: fxOff },
    { id: 'explosion', run: () => engine.ctx.peek('fx')?.debugBurst?.('explosion'), reset: fxOff },
    { id: 'muzzle', run: () => engine.ctx.peek('fx')?.debugBurst?.('muzzle'), reset: fxOff },
    { id: 'combat', run: () => engine.ctx.peek('fx')?.debugBurst?.('combat'), reset: fxOff },
    /**
     * `debugPose('idle')` is NOT a neutral reset — it sets `debugMode = 'idle'`,
     * and WeaponSystem gates firing on `debugMode === null`. Clear the field.
     */
    { id: 'fire', run: () => engine.ctx.peek('weapons')?.debugPose?.('fire'),
      reset: () => { const w = engine.ctx.peek('weapons'); if (w) w.debugMode = null; } },
    { id: 'ads', run: () => engine.ctx.peek('weapons')?.debugPose?.('ads'),
      reset: () => { const w = engine.ctx.peek('weapons'); if (w) w.debugMode = null; } },
    { id: 'ui', run: () => engine.ctx.peek('ui')?.debugState?.('combat'),
      reset: () => engine.ctx.peek('ui')?.debugState?.('clean') },
    /**
     * The low-health pass sets `enabled` from health every frame, so it cannot
     * be forced on directly — it would be switched straight back off before it
     * ever rendered. Dropping health through the real accessor is the only way
     * to make the pass run, and running it is the only way its program is built.
     */
    {
      id: 'lowhealth',
      run: () => {
        const h = engine.ctx.peek('player')?.health;
        if (!h) return;
        h.__warmPrev = h.value;
        h.value = h.max * 0.12;
      },
      reset: () => {
        const h = engine.ctx.peek('player')?.health;
        if (h?.__warmPrev === undefined) return;
        h.value = h.__warmPrev;
        delete h.__warmPrev;
      },
    },
  ];
  })();

  /** The cheap subset that covers every program measured compiling in play. */
  /** Stages that actually executed, so only their resets run. */
  const ranStages = [];

  /**
   * `lite` warmed only what a program-count probe caught compiling. That was too
   * narrow: three creates the program object during compile(), but ANGLE defers
   * the actual D3D translation to the first real DRAW, and a program that
   * already exists does not move `info.programs.length`. So the counter reads
   * zero while the first trigger pull still pays for the translation — which is
   * exactly the reported "stutters when first starting shooting".
   *
   * `play` therefore warms everything that a player triggers in the first
   * seconds of a fight — the FX bursts, the fire/ADS poses, the combat HUD — and
   * skips only `ai`, whose staged firefight builds characters and dominates the
   * cost. Numbers, per tools/warm-cost.mjs, are in the table there.
   */
  const SETS = {
    lite: ['muzzle', 'lowhealth'],
    play: ['wall', 'explosion', 'muzzle', 'combat', 'fire', 'ads', 'ui', 'lowhealth'],
    full: transientStages.map((x) => x.id),
  };
  const chosenStages = Array.isArray(SETS[transients])
    ? transientStages.filter((x) => SETS[transients].includes(x.id))
    : transients
      ? transientStages
      : [];

  // A RENDER TARGET MUST BE BOUND WHILE COMPILING. three folds `outputColorSpace`
  // and `toneMapping` into the program cache key and reads BOTH off the currently
  // bound target. With the canvas bound (the default here) every program compiled
  // is the `srgb` + tone-mapped variant — but the world and the viewmodel are both
  // drawn into HDR targets, which need `srgb-linear` + NoToneMapping. Measured by
  // src/materials and src/fx independently: 25 of 47 pre-warmed programs were the
  // unused canvas variant, and the real ones still compiled during the first
  // frames of play. A 1x1 target is enough to get the right key; nothing is ever
  // rendered into it. Restored in the caller's `finally`.
  const scratchRt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  const prevRt = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace?.() ?? 0;
  const prevMip = renderer.getActiveMipmapLevel?.() ?? 0;

  const compile = async () => {
    // compileAsync is non-blocking where KHR_parallel_shader_compile exists.
    renderer.setRenderTarget(scratchRt);
    try {
      await renderer.compileAsync(engine.scene, engine.camera);
      await renderer.compileAsync(engine.viewScene, engine.viewCamera);
    } catch {
      // Older three or a driver without the extension — fall back to sync.
      try {
        renderer.compile(engine.scene, engine.camera);
        renderer.compile(engine.viewScene, engine.viewCamera);
      } catch { /* nothing more we can do; boot must still proceed */ }
    } finally {
      renderer.setRenderTarget(prevRt, prevFace, prevMip);
    }
  };

  const yieldFrame = waitFrame;

  let aborted = false;
  try {
    let step = 0;
    const totalSteps = WARM_POSES.length * 2 + (drawFrames ? 8 : 0) + chosenStages.length + 1;
    const tick = () => onProgress(Math.min(1, ++step / totalSteps));

    // Pass 1: compile the static world from each pose, with the depth/shadow
    // variants reached by drawing a real frame at that pose.
    for (const p of WARM_POSES) {
      cam.position.set(...p.pos);
      cam.lookAt(...p.look);
      cam.updateMatrixWorld(true);
      normaliseLightPermutation();
      if (beforeJob) await beforeJob();
      else checkAbort();
      await compile();
      checkAbort();
      tick();
      // Drawing real frames here would reach the depth/shadow and post-processing
      // variants too, but engine.step() advances every subsystem's internal state
      // (AI transforms, exposure adaptation, particle cursors) and NONE of that is
      // restorable from core. The pixel gate measured up-to-180/255 deltas from it.
      // So this is opt-in and off: compileAsync only, which mutates nothing.
      if (drawFrames) {
        if (isPaced) {
          await beforeJob();
          engine.step();
          await beforeJob();
          engine.step();
        } else {
          engine.step();
          await yieldFrame();
          engine.step();
          await yieldFrame();
        }
      }
      tick();
    }

    /**
     * Pass 1a: A FULL TURN, drawn.
     *
     * The four warm poses all look down the street, and compiling does not care
     * where the camera points — but the remaining first-use costs are not
     * compiles. They are first DRAWS: three uploads a geometry's buffers and
     * binds a mesh's textures on the frame it first enters the frustum, and a
     * program whose key depends on the object (instanced, vertex-coloured,
     * skinned) is only built when that object is drawn.
     *
     * MEASURED on an RTX 4080 by spinning the view: one world material compiled
     * for 685-901 ms at 6.5 s into play and another for 384 ms at 17 s, both
     * while turning to face geometry the warm poses never looked at. A turn at
     * the spawn point is where the player actually is, and eight directions at
     * ~8 ms each is the cheapest coverage available.
     */
    if (drawFrames) {
      const base = cam.position.clone();
      const baseFov = cam.fov;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        cam.position.copy(base);
        cam.lookAt(base.x + Math.sin(a) * 10, base.y, base.z + Math.cos(a) * 10);
        cam.updateMatrixWorld(true);
        normaliseLightPermutation();
        if (isPaced) await beforeJob();
        else checkAbort();
        engine.step();
        if (isPaced) await beforeJob();
        else await yieldFrame();
        tick();
      }
      cam.position.copy(base);
      cam.fov = baseFov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    }

    // Pass 1b: THE SUBSYSTEM HOOKS. This is the `prewarmMaterials()` contract the
    // doc comment above says is missing — "a prewarmMaterials() on each subsystem
    // that builds and compiles its materials WITHOUT spawning gameplay objects".
    // It is now implemented by render, world and ai, and it reaches exactly what
    // `compileAsync(scene, camera)` provably cannot:
    //
    //   render  the CSM depth pass, the MRT prepass and the ~13 full-screen post
    //           materials (blitted into a 4x4 scratch). +34-40 programs.
    //   world   the CSM-depth and prepass override variants of the level geometry,
    //           in their plain / instanced / instanced+instanceColor flavours,
    //           compiled at the stabilised light count. +35 programs.
    //   ai      the 26 character materials and their skinned + depth variants,
    //           against a dummy SkinnedMesh on the real skeleton. +7 programs.
    //           (ai also calls this itself at the end of init(); it is idempotent.)
    //
    // None of them draws a gameplay frame, steps the engine, touches the clock or
    // the RNG, so none of the restore machinery above applies to them — which is
    // why this replaces the `drawFrames` option rather than extending it.
    //
    // The camera goes back to its real pose FIRST: render's hook runs the shadow
    // and prepass passes for real (at frame 0, where it is pixel-clean), and there
    // is no reason to fit the cascades to a warm-up pose the game never uses.
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    normaliseLightPermutation();

    // render goes first, deliberately: it patches every lit material with the
    // CSM/AO/SSR injection, and a program compiled off an UNPATCHED material is
    // thrown away by the first frame that walks the scene.
    const hooks = [];
    const renderSys = engine.registry.peek?.('render');
    if (renderSys && typeof renderSys.prewarmMaterials === 'function') hooks.push(renderSys);
    for (const sys of engine.registry.ordered ?? []) {
      if (sys === renderSys) continue;
      if (SELF_WARMING.has(sys.constructor?.id)) continue;
      if (typeof sys.prewarmMaterials === 'function') hooks.push(sys);
    }
    const hookResults = {};
    /**
     * A RENDER TARGET STAYS BOUND THROUGH THE HOOKS.
     *
     * three folds the color space of the BOUND target into the program key: with
     * a target bound the key carries `srgb-linear`, with the canvas it carries
     * `srgb`. The world and the viewmodel are both drawn into HDR targets, so the
     * `srgb` variant can never be requested by a frame — and the hooks that
     * compile depth/prepass variants (`world.prewarmMaterials` under
     * `csm.depthMaterial`, render's own CSM step) used to run with the canvas
     * bound, so boot built the useless variant and the real one compiled on the
     * first shadowed frame.
     *
     * MEASURED on an RTX 4080: `csm-depth` + `ow-prepass` for 198-218 ms at
     * ~1.3 s into play, every run, with compiles otherwise complete.
     */
    renderer.setRenderTarget(scratchRt);
    try {
      for (const sys of hooks) {
        const id = sys.constructor?.id ?? '?';
        try {
          if (beforeJob) await beforeJob();
          else checkAbort();
          const arg = sys === renderSys
            ? {
              post: true,
              shadow,
              beforeJob: beforeJob ?? undefined,
              signal: paceSignal,
            }
            : engine.ctx;
          // The second argument is deliberately optional/backward-compatible.
          // Hooks that perform several real warm-up draws can use it to admit
          // each draw on a separate frame; existing one-argument hooks ignore it.
          hookResults[id] = (await sys.prewarmMaterials(arg, {
            beforeJob: beforeJob ?? undefined,
            signal: paceSignal,
          })) ?? { ok: true };
          checkAbort();
        } catch (err) {
          if (err?.name === 'AbortError' || paceSignal?.aborted) throw err;
          // An optional hook must never be able to block boot.
          hookResults[id] = { ok: false, reason: String(err?.message ?? err) };
        } finally {
          // A hook may have left its own target bound; the next one needs the
          // linear scratch back, or it compiles the canvas variant.
          renderer.setRenderTarget(scratchRt);
        }
      }
    } finally {
      renderer.setRenderTarget(prevRt, prevFace, prevMip);
    }
    engine.__prewarmHooks = hookResults;

    // Pass 2: spawn each subsystem's transient objects and compile those too.
    // Gated: see the `transients` option doc — this pass is not pixel-transparent.
    for (const stage of chosenStages) {
      if (isPaced) {
        // Staging plus its first draw is one coarse job: the transient only
        // exists so that this draw can materialise its first-use resources.
        await beforeJob();
        ranStages.push(stage);
        try { stage.run(); } catch { /* subsystem may not implement the hook */ }
        engine.step();
        await beforeJob();
        await compile();
        checkAbort();
        await beforeJob();
        engine.step();
      } else {
        ranStages.push(stage);
        try { stage.run(); } catch { /* subsystem may not implement the hook */ }
        engine.step();
        await yieldFrame();
        await compile();
        engine.step();
        await yieldFrame();
      }
      tick();
    }
    tick();
  } catch (err) {
    if (err?.name === 'AbortError' || paceSignal?.aborted) aborted = true;
    else throw err;
  } finally {
    /**
     * Restore ONLY what was actually staged.
     *
     * This used to be a flat list run whenever the pass ran at all, which was
     * harmless while the pass was all-or-nothing and became a hard bug the
     * moment a SUBSET could run: `weapons.debugPose('idle')` fired even though
     * no weapon pose had been staged, and `debugPose` sets `debugMode = 'idle'`
     * — not null. `live` in WeaponSystem.update is gated on `debugMode === null`,
     * so shooting and aiming were dead for the whole session.
     *
     * Pairing each reset with its own stage makes that unrepresentable: a reset
     * cannot run for something that never happened.
     */
    for (const stage of ranStages) {
      try { stage.reset?.(); } catch { /* optional hook */ }
    }
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    Object.assign(engine.time, savedTime);
    r.s0 = savedRng.s0;
    r.s1 = savedRng.s1;
    r.s2 = savedRng.s2;
    r.s3 = savedRng.s3;
    r._spare = savedRng.spare;
    engine._accum = savedAccum;
    engine._last = performance.now();
    renderer.setRenderTarget(prevRt, prevFace, prevMip);
    scratchRt.dispose();
  }

  const programsAfter = renderer.info.programs?.length ?? 0;
  if (aborted) {
    return {
      ok: false,
      aborted: true,
      ms: Math.round(performance.now() - t0),
      programsBefore,
      programsAfter,
      compiled: programsAfter - programsBefore,
    };
  }
  return {
    ok: true,
    hooks: engine.__prewarmHooks,
    ms: Math.round(performance.now() - t0),
    programsBefore,
    programsAfter,
    compiled: programsAfter - programsBefore,
    parallel: !!renderer.getContext().getExtension('KHR_parallel_shader_compile'),
  };
}
