import { NoiseBank } from './dsp.js';
import { weaponShot } from './weapons.js';
import { shellCasing, surfaceImpact } from './foley.js';

/**
 * BAKED VOICES.
 *
 * A procedural gunshot costs 547 Web Audio operations to assemble — 294
 * connects, 135 gains, 72 filters, 37 buffer sources (tools/audio-cost.mjs). At
 * 700 RPM that is ~6350 graph mutations a second on the main thread, and it was
 * the stutter while shooting. None of it appears in renderer.info or in
 * usedJSHeapSize, because Web Audio backing stores sit outside the JS heap —
 * which is why an earlier flat-heap reading wrongly cleared audio.
 *
 * The synthesis was never the cost; NoiseBank bakes its noise once. The cost is
 * rebuilding a voice GRAPH per event. So a voice is rendered once per variant
 * through an OfflineAudioContext, using the very same synthesis code, and
 * playing it becomes a buffer source and a gain: THREE operations.
 *
 * WHAT GETS BAKED, and why it is these three. Measuring voices per trigger pull
 * (tools/_kinds.mjs) gave: shell 3.13, shot 1.39, impact 1.06. The shell casing
 * — which bounces two or three times, each bounce its own layer — costs more
 * than the gunshot. Baking the gunshot alone moved 547 to 449, an 18% cut,
 * because the gunshot was never the bulk. All three are baked now.
 *
 * WHAT IS DELIBERATELY NOT BAKED: distance. `weaponShot` rebalances its layers
 * by range, so a buffer rendered at zero metres is only honest at zero metres.
 * Only the first-person shot is baked — the player holding the trigger, exactly
 * the hot path. Enemy fire across the map is a few voices a second and stays
 * fully procedural, so propagation, occlusion and range mixing are untouched.
 *
 * Variation survives three ways: the round-robin inside `weaponShot` is baked
 * across the variants, playback rotates variants, and a small playback-rate
 * jitter detunes each one for free.
 */

const VARIANTS = 6;

/**
 * Render length per kind. `weaponShot` reports its own tail via `end`; these are
 * caps chosen to clear the longest tail (the AK's 0.42 s decay plus the ground
 * bounce). Too short truncates a tail into a click.
 */
const SECONDS = { shot: 1.8, shell: 1.2, impact: 1.0 };

const RATE_JITTER = 0.02;

/**
 * Shell casings only distinguish hard / soft / everything else, so three baked
 * classes cover every surface in the game rather than one per material.
 */
export function shellClass(surface) {
  if (surface === 'metal' || surface === 'concrete' || surface === 'glass' || surface === 'plaster') return 'hard';
  if (surface === 'dirt' || surface === 'sand' || surface === 'foliage' || surface === 'fabric') return 'soft';
  return 'mid';
}

export class VoiceBank {
  /** @param {object} rng forkable RNG; baking must not disturb the live stream */
  constructor(rng) {
    this.rng = rng;
    /** key -> AudioBuffer[] */
    this.banks = new Map();
    /** key -> Promise, so a repeated request never bakes twice */
    this.pending = new Map();
    /** key -> (offlineCtx, noiseBank, rng) => {node,end,send} */
    this.recipes = new Map();
    this._rr = new Map();
    this.stats = { baked: 0, played: 0, misses: 0 };
  }

  register(key, seconds, render) {
    if (!this.recipes.has(key)) this.recipes.set(key, { seconds, render });
  }

  has(key) {
    return this.banks.has(key);
  }

  /** Idempotent; returns immediately. Nothing ever waits on a bake. */
  request(key, sampleRate) {
    if (this.banks.has(key) || this.pending.has(key)) return this.pending.get(key);
    const recipe = this.recipes.get(key);
    if (!recipe) return undefined;
    const job = this._bake(recipe, sampleRate)
      .then((bufs) => {
        this.banks.set(key, bufs);
        this.stats.baked += bufs.length;
      })
      .catch((err) => {
        // A failed bake must never break the game — the procedural path is
        // still there and still correct, only expensive.
        console.warn('[audio] voice bake failed, staying procedural', key, err);
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  async _bake({ seconds, render }, sampleRate) {
    const sr = sampleRate > 0 ? sampleRate : 48000;
    const out = [];
    for (let i = 0; i < VARIANTS; i++) {
      const oc = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
      // A NoiseBank per render, in the render's own context. Its buffers are the
      // expensive part of construction — paid VARIANTS times at load instead of
      // on every event forever.
      const bank = new NoiseBank(oc, this.rng.fork());
      const voice = render(oc, bank, this.rng.fork());
      voice.node.connect(oc.destination);
      out.push(await oc.startRendering());
    }
    return out;
  }

  /**
   * @returns {{node:AudioNode, end:number, send:number}|null} the shape the
   *          synthesis functions return, or null when this key is not baked yet
   *          — the caller then falls back to synthesising it.
   */
  play(actx, key, rng, when, { level = 1, send = 0.3 } = {}) {
    const bufs = this.banks.get(key);
    if (!bufs || !bufs.length) {
      this.stats.misses++;
      return null;
    }
    // Round-robin, not random: random audibly repeats, and the point of six
    // variants is never hearing the same one twice running.
    const n = ((this._rr.get(key) ?? -1) + 1) % bufs.length;
    this._rr.set(key, n);
    const buf = bufs[n];

    const src = actx.createBufferSource();
    src.buffer = buf;
    const rate = 1 + rng.range(-RATE_JITTER, RATE_JITTER);
    src.playbackRate.value = rate;
    const g = actx.createGain();
    g.gain.value = level;
    src.connect(g);
    src.start(when);
    this.stats.played++;

    return {
      node: g,
      // Divided by the rate: detuning down stretches the voice, and a short
      // `end` would let the mixer free the emitter mid-tail.
      end: when + buf.duration / rate + 0.05,
      send,
    };
  }

  /**
   * Register the three high-rate voices. Called once, as soon as the graph
   * exists, so the sample rate is known.
   */
  registerDefaults(profile) {
    this.register(profile, SECONDS.shot, (oc, bank, rng) =>
      weaponShot(oc, bank, rng, profile, {
        // Absolute zero, not `currentTime`: an offline context starts at 0 and
        // anything later bakes silence into the head of the buffer.
        when: 0,
        distance: 0,
        firstPerson: true,
        // `echoBoost` only scales the returned `send`, never the graph, so the
        // reverb amount stays live and room-dependent at playback.
        echoBoost: 1,
      })
    );
    for (const cls of ['hard', 'soft', 'mid']) {
      const surface = cls === 'hard' ? 'concrete' : cls === 'soft' ? 'dirt' : 'wood';
      this.register(`shell:${cls}`, SECONDS.shell, (oc, bank, rng) =>
        // `flight: 0` — the casing's arc is applied by scheduling the start
        // later at playback, so one bake covers every flight time instead of
        // baking a different length of leading silence for each.
        shellCasing(oc, bank, rng, { when: 0, surface, level: 1, flight: 0 })
      );
      this.register(`impact:${cls}`, SECONDS.impact, (oc, bank, rng) =>
        // Nominal energy; the real energy scales the playback gain. Energy
        // mostly moves level, which a gain reproduces exactly.
        surfaceImpact(oc, bank, rng, { when: 0, surface, energy: 1 })
      );
    }
  }

  dispose() {
    this.banks.clear();
    this.pending.clear();
    this.recipes.clear();
  }
}
