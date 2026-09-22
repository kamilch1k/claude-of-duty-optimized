import { el, setText, setStyle, clamp, damp, ease } from './util.js';
import { OPTIC_ORDER } from '../weapons/optics.js';
import { MUZZLE_ORDER } from '../weapons/muzzles.js';
import { MAG_ORDER } from '../weapons/mags.js';
import { STOCK_ORDER } from '../weapons/stocks.js';
import { SKIN_ORDER, SKINS } from '../weapons/skins.js';

/** Short labels for the segmented control; full names live in stocks.js. */
const STOCK_LABELS = { collapsed: 'short', standard: 'std', extended: 'long' };

/** Short labels for the segmented control; full names live in mags.js. */
const MAG_LABELS = { short: 'short', std: 'std', ext: 'ext' };

/** Short labels for the segmented control; full names live in muzzles.js. */
const MUZZLE_LABELS = {
  bare: 'bare',
  a2: 'a2',
  brake: 'brake',
  comp: 'comp',
  can: 'can',
  trilug: 'trilug',
};

/** Short enough to fit a segmented control; the full names live in optics.js. */
const OPTIC_LABELS = {
  irons: 'irons',
  reddot: 'dot',
  okp7: 'okp-7',
  acog: '4x',
  vari: '1-6x',
};

const PRESETS = ['performance', 'low', 'medium', 'high', 'ultra'];

/**
 * Short enough for a five-way segmented control on a 430 px panel.
 * "PERFORMANCE" pushed the row label onto a second line and made the whole
 * column read as ragged, which is a bad trade for one word.
 */
const PRESET_LABELS = { performance: 'perf', low: 'low', medium: 'med', high: 'high', ultra: 'ultra' };

/**
 * The advanced switches, in the order they cost frame time on the web profile.
 * Shadows first because they are 1.3 ms of a 4.5 ms frame at 1080p — 326 of the
 * frame's 644 draw calls and 3.0M of its 5.1M triangles.
 */
const FEATURES = [
  ['shadows', 'Sun Shadows'],
  ['contact', 'Contact Shadows'],
  ['gtao', 'Ambient Occlusion'],
  ['ssr', 'Screen-Space Reflections'],
  ['volumetrics', 'Volumetric Light'],
  ['bloom', 'Bloom'],
  ['motionBlur', 'Motion Blur'],
  ['dof', 'Depth Of Field'],
  ['taa', 'Temporal AA'],
];

/**
 * Pause / settings menu.
 *
 * Wired straight into `ctx.config`: the quality segments call
 * `config.setQuality`, the sliders write `config.sensitivity` and `config.fov`
 * (and push the FOV into the live camera), and every change is announced on the
 * event bus so render/player can react without importing this module.
 *
 * Events emitted: `ui:pause` {paused}, `ui:quality` {quality},
 * `ui:sensitivity` {value}, `ui:fov` {value}, `ui:setting` {key, value}.
 */
export class PauseMenu {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.root = el('div', 'ow-menu', parent);
    const inner = el('div', 'ow-menu-inner', this.root);

    this.title = el('h1', null, inner, 'PAUSED');
    el('div', 'sub', inner, 'OVERWATCH — TACTICAL OPERATIONS');
    el('div', 'rule', inner);

    /**
     * TWO PAGES, ONE OVERLAY.
     *
     * Escape used to open the settings screen directly, which meant the two
     * things a player actually wants when they press it — get back to the game,
     * or leave it — were buried under a gunsmith. The first page is the three
     * decisions; the settings page is everything that used to be here, one
     * click further in and one Escape away.
     */
    this.page = 'root';
    this.rootPage = el('div', 'ow-page', inner);
    const rootBtns = el('div', 'ow-btns ow-btns-col', this.rootPage);
    this.playBtn = el('button', 'ow-btn primary ow-btn-wide', rootBtns, 'Play');
    this.playBtn.type = 'button';
    this.playBtn.addEventListener('click', () => this.close());
    this.settingsBtn = el('button', 'ow-btn ow-btn-wide', rootBtns, 'Settings');
    this.settingsBtn.type = 'button';
    this.settingsBtn.addEventListener('click', () => this.setPage('settings'));
    this.exitBtn = el('button', 'ow-btn ow-btn-wide ow-btn-danger', rootBtns, 'Exit to menu');
    this.exitBtn.type = 'button';
    this.exitBtn.addEventListener('click', () => this.exit());

    this.settingsPage = el('div', 'ow-page', inner);
    this.rows = el('div', null, this.settingsPage);

    // ---- quality preset --------------------------------------------------
    this.qBtns = [];
    const qRow = this._row('Graphics Preset');
    const seg = el('div', 'ow-seg', qRow);
    for (const p of PRESETS) {
      const b = el('button', null, seg, PRESET_LABELS[p] ?? p);
      b.type = 'button';
      b.addEventListener('click', () => this.setQuality(p));
      this.qBtns.push(b);
    }

    // ---- optic ------------------------------------------------------------
    /**
     * In-match gunsmith, such as it is. Nothing is rebuilt when you pick a
     * sight — every optic was built at load and this flips which one is visible
     * (see weapons/optics.js), so it is safe to change mid-firefight.
     *
     * Fitted to the weapon in your hands, not to a loadout slot: swap to the
     * SMG and this row follows it.
     */
    this.opticRow = this._row('Optic');
    this.opticSeg = el('div', 'ow-seg', this.opticRow);
    this.opticBtns = [];
    for (const id of OPTIC_ORDER) {
      const b = el('button', null, this.opticSeg, OPTIC_LABELS[id]);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.peek('weapons')?.setOptic?.(id);
        this.syncFromConfig();
      });
      this.opticBtns.push([b, id]);
    }
    this.opticNote = el('div', 'val', this.opticRow, '');

    // ---- muzzle device ----------------------------------------------------
    // Same build-all/toggle scheme as the optic; the note shows how far the
    // fitted device carries, because that is the stat the choice is about.
    this.muzzleRow = this._row('Muzzle');
    const mSeg = el('div', 'ow-seg', this.muzzleRow);
    this.muzzleBtns = [];
    for (const id of [...MUZZLE_ORDER, 'trilug']) {
      const b = el('button', null, mSeg, MUZZLE_LABELS[id]);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.peek('weapons')?.setMuzzle?.(id);
        this.syncFromConfig();
      });
      this.muzzleBtns.push([b, id]);
    }
    this.muzzleNote = el('div', 'val', this.muzzleRow, '');

    // ---- magazine ---------------------------------------------------------
    this.magRow = this._row('Magazine');
    const gSeg = el('div', 'ow-seg', this.magRow);
    this.magBtns = [];
    for (const id of MAG_ORDER) {
      const b = el('button', null, gSeg, MAG_LABELS[id]);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.peek('weapons')?.setMag?.(id);
        this.syncFromConfig();
      });
      this.magBtns.push([b, id]);
    }
    this.magNote = el('div', 'val', this.magRow, '');

    // ---- stock ------------------------------------------------------------
    this.stockRow = this._row('Stock');
    const sSeg = el('div', 'ow-seg', this.stockRow);
    this.stockBtns = [];
    for (const id of STOCK_ORDER) {
      const b = el('button', null, sSeg, STOCK_LABELS[id]);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.peek('weapons')?.setStock?.(id);
        this.syncFromConfig();
      });
      this.stockBtns.push([b, id]);
    }
    this.stockNote = el('div', 'val', this.stockRow, '');

    // ---- skin -------------------------------------------------------------
    this.skinRow = this._row('Finish');
    const kSeg = el('div', 'ow-seg', this.skinRow);
    this.skinBtns = [];
    for (const id of SKIN_ORDER) {
      const b = el('button', null, kSeg, SKINS[id].label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.peek('weapons')?.setSkin?.(id);
        this.syncFromConfig();
      });
      this.skinBtns.push([b, id]);
    }

    // ---- advanced graphics ------------------------------------------------
    /**
     * Per-effect switches, live, on top of the preset.
     *
     * A preset is a single dial and it is the wrong shape for "the shadows cost
     * me a third of my frame but I want to keep the bloom". These call straight
     * into the render subsystem's `setFeature`, which gates each pass behind a
     * getter — no reload, no pipeline rebuild.
     *
     * A preset that never CONSTRUCTED a pass cannot switch it on (the object
     * does not exist), so those rows render disabled and say why rather than
     * offering a dead toggle. Raise the preset and they come alive.
     */
    this.advOpen = false;
    const advRow = this._row('Advanced');
    this.advBtn = el('button', 'ow-btn', advRow, 'Show');
    this.advBtn.type = 'button';
    this.advBtn.addEventListener('click', () => {
      this.advOpen = !this.advOpen;
      setText(this.advBtn, this.advOpen ? 'Hide' : 'Show');
      setStyle(this.adv, 'display', this.advOpen ? '' : 'none');
      if (this.advOpen) this.syncFromConfig();
    });
    this.adv = el('div', null, this.rows);
    setStyle(this.adv, 'display', 'none');
    this.featBtns = [];
    for (const [key, label] of FEATURES) {
      const r = el('div', 'ow-row', this.adv);
      el('div', 'name', r, label.toUpperCase());
      const seg = el('div', 'ow-seg', r);
      const pair = [];
      for (const [txt, on] of [
        ['off', false],
        ['on', true],
      ]) {
        const b = el('button', null, seg, txt);
        b.type = 'button';
        b.addEventListener('click', () => {
          this._setFeature(key, on);
          this.ctx.events.emit('ui:setting', { key: `gfx.${key}`, value: on });
          this.syncFromConfig();
        });
        pair.push([b, on]);
      }
      const note = el('div', 'val', r, '');
      this.featBtns.push({ key, pair, note });
    }

    // ---- sensitivity -----------------------------------------------------
    this.sens = this._slider('Mouse Sensitivity', 0.2, 3.0, 0.01, (v) => {
      this.ctx.config.sensitivity = 0.0022 * v;
      this.ctx.events.emit('ui:sensitivity', { value: this.ctx.config.sensitivity, multiplier: v });
      return v.toFixed(2);
    });

    // ---- field of view ---------------------------------------------------
    this.fov = this._slider('Field Of View', 65, 120, 1, (v) => {
      this.ctx.config.fov = v;
      const cam = this.ctx.camera;
      if (cam) {
        cam.fov = v;
        cam.updateProjectionMatrix();
      }
      this.ctx.events.emit('ui:fov', { value: v });
      return String(v | 0);
    });

    // ---- invert look -----------------------------------------------------
    const invRow = this._row('Invert Look');
    const invSeg = el('div', 'ow-seg', invRow);
    this.invBtns = [];
    for (const [label, val] of [
      ['off', false],
      ['on', true],
    ]) {
      const b = el('button', null, invSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.config.invertY = val;
        this.ctx.events.emit('ui:setting', { key: 'invertY', value: val });
        this.syncFromConfig();
      });
      this.invBtns.push([b, val]);
    }

    // ---- buttons ---------------------------------------------------------
    const btns = el('div', 'ow-btns', this.settingsPage);
    this.backBtn = el('button', 'ow-btn', btns, 'Back');
    this.backBtn.type = 'button';
    this.backBtn.addEventListener('click', () => this.setPage('root'));
    const reset = el('button', 'ow-btn', btns, 'Defaults');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.sens.set(1);
      this.fov.set(80);
      this.ctx.config.invertY = false;
      this.setQuality('ultra');
    });
    el('div', 'hint', this.settingsPage, 'ESC BACK · WASD MOVE · SHIFT SPRINT · R RELOAD · F USE');

    this.open = false;
    this.shown = 0;
    this.setPage('root');
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'cursor', 'default');
    this.syncFromConfig();
  }

  /** 'root' | 'settings'. The overlay itself is the same either way. */
  setPage(page = 'root') {
    const settings = page === 'settings';
    this.page = settings ? 'settings' : 'root';
    setStyle(this.rootPage, 'display', settings ? 'none' : '');
    setStyle(this.settingsPage, 'display', settings ? '' : 'none');
    setText(this.title, settings ? 'SETTINGS' : 'PAUSED');
    if (settings) this.syncFromConfig();
  }

  _row(name) {
    const r = el('div', 'ow-row', this.rows);
    el('div', 'name', r, name.toUpperCase());
    return r;
  }

  _slider(name, min, max, step, apply) {
    const row = this._row(name);
    const wrap = el('div', 'ow-slider', row);
    el('div', 'track', wrap);
    const fill = el('div', 'fill', wrap);
    const knob = el('div', 'knob', wrap);
    const input = el('input', null, wrap);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = el('div', 'val', row, '');

    const paint = (v) => {
      const t = (v - min) / (max - min);
      setStyle(fill, 'width', (t * 100).toFixed(2) + '%');
      setStyle(knob, 'left', (t * 100).toFixed(2) + '%');
      setText(val, apply(v) ?? String(v));
    };
    input.addEventListener('input', () => paint(parseFloat(input.value)));
    const api = {
      set: (v) => {
        const c = clamp(v, min, max);
        input.value = String(c);
        paint(c);
      },
    };
    return api;
  }

  /**
   * Volumetric light lives in `sky`, everything else in `render` — the panel is
   * the only place that has to know which, so the two subsystems stay unaware
   * of each other.
   */
  _setFeature(key, on) {
    if (key === 'volumetrics') {
      const v = this.ctx.peek('sky')?.volumetrics;
      if (v?.marchAvailable) v.marchEnabled = !!on;
      return;
    }
    this.ctx.peek('render')?.setFeature?.(key, on);
  }

  _featureState(key) {
    if (key === 'volumetrics') {
      const v = this.ctx.peek('sky')?.volumetrics;
      return { available: !!v?.marchAvailable, on: !!v?.marchEnabled };
    }
    const r = this.ctx.peek('render');
    if (!r) return { available: false, on: false };
    return { available: !!r.featureAvailable?.(key), on: !!r.opt?.[key] };
  }

  setQuality(name) {
    try {
      this.ctx.config.setQuality(name);
      this.ctx.events.emit('ui:quality', { quality: name });
    } catch (err) {
      console.warn('[ui] quality switch failed', err);
    }
    this.syncFromConfig();
  }

  syncFromConfig() {
    const cfg = this.ctx.config;
    for (let i = 0; i < this.qBtns.length; i++)
      this.qBtns[i].classList.toggle('on', PRESETS[i] === cfg.quality);
    for (const [b, v] of this.invBtns) b.classList.toggle('on', !!cfg.invertY === v);
    const wp = this.ctx.peek('weapons');
    const fitted = wp?.opticId ?? null;
    for (const [b, id] of this.opticBtns ?? []) {
      const has = !!wp?.viewmodel?.weapons.get(wp.activeId)?.optics?.[id];
      b.classList.toggle('on', fitted === id);
      b.disabled = !has;
      setStyle(b, 'opacity', has ? '' : '0.35');
    }
    if (this.opticNote) {
      const range = wp?.opticMagRange;
      setText(
        this.opticNote,
        range ? `${wp.adsMagnification.toFixed(1)}x · wheel` : ''
      );
    }
    const fittedM = wp?.muzzleId ?? null;
    for (const [b, id] of this.muzzleBtns ?? []) {
      const has = !!wp?.viewmodel?.weapons.get(wp.activeId)?.muzzles?.[id];
      b.classList.toggle('on', fittedM === id);
      b.disabled = !has;
      setStyle(b, 'opacity', has ? '' : '0.35');
    }
    if (this.muzzleNote) setText(this.muzzleNote, wp?.muzzle ? `heard ${wp.muzzle.loudness} m` : '');
    const fittedG = wp?.magId ?? null;
    for (const [b, id] of this.magBtns ?? []) {
      const has = !!wp?.viewmodel?.weapons.get(wp.activeId)?.mags?.[id];
      b.classList.toggle('on', fittedG === id);
      b.disabled = !has;
      setStyle(b, 'opacity', has ? '' : '0.35');
    }
    if (this.magNote) {
      const g = wp?.magSpec;
      setText(this.magNote, g ? `${g.rounds} rds · reload x${g.reload.toFixed(2)}` : '');
    }
    const fittedS = wp?.stockId ?? null;
    for (const [b, id] of this.stockBtns ?? []) {
      const has = !!wp?.viewmodel?.weapons.get(wp.activeId)?.stocks?.[id];
      b.classList.toggle('on', fittedS === id);
      b.disabled = !has;
      setStyle(b, 'opacity', has ? '' : '0.35');
    }
    if (this.stockNote) {
      const st = wp?.stockSpec;
      setText(this.stockNote, st ? `recoil x${st.recoil.toFixed(2)}` : '');
    }
    const fittedK = wp?.skinId ?? 'black';
    for (const [b, id] of this.skinBtns ?? []) b.classList.toggle('on', fittedK === id);
    for (const f of this.featBtns ?? []) {
      const st = this._featureState(f.key);
      for (const [b, v] of f.pair) {
        b.classList.toggle('on', st.available && st.on === v);
        b.disabled = !st.available;
        setStyle(b, 'opacity', st.available ? '' : '0.35');
      }
      setText(f.note, st.available ? '' : 'preset');
    }
    this.sens?.set((cfg.sensitivity ?? 0.0022) / 0.0022);
    this.fov?.set(cfg.fov ?? 80);
  }

  /**
   * Escape goes BACK one level before it goes anywhere else: from the settings
   * page it returns to the three buttons, and only from the root does it resume
   * the match. Closing the whole overlay out of a submenu is how a player ends
   * up unpaused mid-firefight with a slider they were still reading.
   */
  toggle() {
    if (!this.open) {
      this.show();
      return;
    }
    if (this.page === 'settings') {
      this.setPage('root');
      return;
    }
    this.close();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.setPage('root');
    this.syncFromConfig();
    setStyle(this.root, 'display', '');
    // Release the cursor AND stop anything re-grabbing it: a click on a setting
    // must land on the setting, not be swallowed by a re-lock.
    if (this.ctx.input) this.ctx.input.lockSuppressed = true;
    document.exitPointerLock?.();
    const t = this.ctx.time;
    if (t) {
      this._prevScale = t.scale;
      t.scale = 0;
    }
    this.ctx.peek('player')?.setControlEnabled?.(false);
    this.ctx.events.emit('ui:pause', { paused: true });
  }

  close({ relock = true } = {}) {
    if (!this.open) return;
    this.open = false;
    this.setPage('root');
    const t = this.ctx.time;
    if (t) t.scale = this._prevScale ?? 1;
    this.ctx.peek('player')?.setControlEnabled?.(true);
    if (this.ctx.input) this.ctx.input.lockSuppressed = false;
    // A close that is really a teardown must NOT re-grab the pointer: the front
    // menu is about to want it.
    if (relock) this.ctx.input?.requestPointerLock?.();
    this.ctx.events.emit('ui:pause', { paused: false });
  }

  /**
   * Leave the match. The UI does not own the engine lifecycle, so this only
   * restores what `show()` froze and announces the intent — main.js disposes the
   * engine and puts the front menu back up.
   */
  exit() {
    this.close({ relock: false });
    this.ctx.events.emit('ui:exit');
  }

  /** Driven with unscaled time so the fade still runs while the game is frozen. */
  update(rawDt) {
    this.shown = damp(this.shown, this.open ? 1 : 0, 14, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));
  }

  dispose() {
    this.root.remove();
  }
}
