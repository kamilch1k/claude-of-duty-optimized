/**
 * WHO ALLOCATES A GPU TEXTURE, BY CALL STACK.
 *
 * `renderer.info.memory.textures` counts BOTH material texture uploads and
 * render-target attachments, and it ticks on first BIND, not on construction.
 * A "+35 textures" frame therefore names no culprit anywhere in either scene
 * graph — this does, by patching the GL entry points three must go through and
 * keeping the stack of whoever called them.
 *
 * Patched at document start, so it sees boot too; entries are filtered to those
 * that happen AFTER `__ENGINE__` exists, which is the play window.
 *
 *   node tools/tex-stack.mjs [url]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/?map=street&menu=0';

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });

await p.addInitScript(() => {
  window.__TEXLOG__ = [];
  const proto = WebGL2RenderingContext.prototype;
  const PATCH = ['texImage2D', 'texStorage2D', 'renderbufferStorage', 'renderbufferStorageMultisample'];
  const label = new WeakMap();
  const GL = WebGL2RenderingContext;

  /** A short, human label for the currently bound program, from its shaders. */
  const programLabel = (gl) => {
    const prog = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!prog) return 'no-program';
    if (label.has(prog)) return label.get(prog);
    let name = '?';
    try {
      const shaders = gl.getAttachedShaders(prog) ?? [];
      for (const s of shaders) {
        const src = gl.getShaderSource(s) ?? '';
        // The uniforms a program declares name it better than anything else:
        // fx passes declare fx-specific samplers, characters declare bone maps.
        const hit = src.match(/uniform\s+sampler2D\s+(\w+)/g)?.slice(0, 4).join(', ')
          ?? src.match(/OW_[A-Z_]+/g)?.slice(0, 3).join(', ')
          ?? src.slice(0, 0);
        if (hit) { name = hit; break; }
      }
    } catch { /* a program mid-link */ }
    label.set(prog, name);
    return name;
  };

  for (const fn of PATCH) {
    const orig = proto[fn];
    if (typeof orig !== 'function') continue;
    proto[fn] = function patched(...a) {
      const e = window.__ENGINE__;
      if (e && window.__TEXLOG__.length < 300) {
        const gl = this;
        const dims = fn === 'texImage2D'
          ? `${a[3]}x${a[4]}`
          : fn === 'texStorage2D'
            ? `${a[3]}x${a[4]}`
            : `${a[2]}x${a[3]}`;
        window.__TEXLOG__.push({
          fn,
          dims,
          internalFormat: fn === 'texStorage2D' ? String(a[2]) : String(a[2]),
          t: Math.round(performance.now()),
          frame: e.time?.frame ?? -1,
          program: programLabel(gl),
        });
      }
      return orig.apply(this, a);
    };
  }
});

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(3000);

/**
 * Reproduce the stimulus that allocates, not a passive idle.
 *
 * A passive page allocates nothing after boot — measured — so a probe that only
 * waits names nothing. This is playprofile's exact loop: engine stopped, frames
 * hand-pumped, WASD held, the view flicked, the trigger down in bursts.
 */
const log = await p.evaluate(async () => {
  const e = window.__ENGINE__;
  const input = e.ctx.input;
  const player = e.ctx.peek('player');
  player?.setControlEnabled?.(true);
  e.stop();

  const script = { lookX: 0, lookY: 0 };
  const realBegin = input.beginFrame.bind(input);
  input.beginFrame = (dt) => {
    realBegin(dt);
    input.look.x = script.lookX;
    input.look.y = script.lookY;
  };

  let t = performance.now();
  for (let f = 0; f < 120; f++) {
    input.down.delete('KeyW');
    input.down.delete('KeyD');
    const leg = Math.floor(f / 120) % 4;
    input.down.add(['KeyW', 'KeyD', 'KeyS', 'KeyA'][leg]);
    script.lookX = Math.sin(f * 0.01) * 0.9 + (f % 300 < 6 ? 7 : 0);
    script.lookY = Math.sin(f * 0.004) * 0.25;
    if (f % 80 < 40) input.down.add('Mouse0');
    else input.down.delete('Mouse0');
    e.step((t += 16.6));
  }
  return window.__TEXLOG__;
});
await b.close();

if (!log.length) {
  console.log('no GL texture/renderbuffer allocation after boot');
} else {
  const byProgram = new Map();
  for (const x of log) {
    const key = `${x.program}  ${x.dims}  ${x.internalFormat}`;
    byProgram.set(key, (byProgram.get(key) ?? 0) + 1);
  }
  console.log(`${log.length} allocations after boot, ${byProgram.size} distinct {program, size, format}\n`);
  for (const [k, n] of [...byProgram].sort((a, c) => c[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}x  ${k}`);
  }
  console.log(`\nframes: ${[...new Set(log.map((x) => x.frame))].join(', ')}`);
  console.log(`functions: ${[...new Set(log.map((x) => x.fn))].join(', ')}`);
}
