/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;
/**
 * Longest frame the simulation will believe, in seconds. Six fixed steps — kept
 * under MAX_SUBSTEPS on purpose, so catch-up is bounded by this clamp and not by
 * the backlog-shedding branch. See the note in Engine.step.
 */
export const MAX_FRAME_DT = 0.05;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  /**
   * PERFORMANCE — the frame-cost floor, for hardware that is nowhere near a
   * 4080 and for the first frame a portal player ever sees.
   *
   * The one structural difference from `low` is `shadows: false`. The cascade
   * pass was measured at 326 of the frame's 644 draw calls and 3.0M of its 5.1M
   * triangles; on a laptop iGPU that is not a line item, it is the frame. Draw
   * calls matter here even on a fast GPU, because the cost that scales with them
   * is the JavaScript-side submission of each one, and that is on the main
   * thread where the input latency lives.
   *
   * Contact shadows come ON to replace them. They are the cheap stand-in that
   * stops everything floating — a short screen-space march resolving the first
   * 0-40 cm under a crate or a boot — and with the cascades gone they are the
   * only thing keeping objects on the ground.
   *
   * Bloom goes for the same reason: another full-screen chain on a build whose
   * job is to hold a frame.
   *
   * Everything here is still available — `?q=low`, the in-game quality menu, and
   * the advanced graphics panel can turn shadows back on live without a rebuild.
   */
  performance: {
    renderScale: 0.7,
    shadows: false,
    contactShadows: true,
    shadowMapSize: 512,
    cascades: 1,
    shadowDistance: 30,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: false,
    anisotropy: 2,
    charTextureSize: 256,
    particleBudget: 1800,
    decalBudget: 48,
  },
  low: {
    // Web-first default: keep the scene readable while avoiding the expensive
    // desktop-only effects that make the first frame and steady-state GPU cost
    // too high for Yandex/Crazy Games hardware.
    renderScale: 0.80,
    shadowMapSize: 1024,
    // ONE cascade, close in. Measured at 1080p: the shadow pass is 326 of the
    // frame's 644 draw calls and 3.0M of its 5.1M triangles, for 1.3 ms of a
    // 4.5 ms frame — by far the biggest single item left. One short cascade
    // keeps objects sitting ON the ground (drop it entirely and everything
    // floats) and gives most of that back.
    cascades: 1,
    shadowDistance: 45,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    // Character texture bake is on the CPU (src/ai/textures.js) and is O(size^2):
    // 512px cost 7.6 s of boot, 256px costs a quarter of that.
    charTextureSize: 256,
    particleBudget: 3500,
    decalBudget: 96,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    charTextureSize: 512,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    charTextureSize: 512,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    charTextureSize: 512,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  // Start in the web-safe profile. Desktop players can opt into `?q=high` or
  // `?q=ultra`, and the in-game quality menu still exposes every preset.
  quality: 'low',
  /** Level to build: 'street' (the full map) or 'box' (greybox arena). */
  map: 'street',
  /** 'tdm' garrisons the level with enemy squads; 'sandbox' spawns none. */
  mode: 'tdm',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
