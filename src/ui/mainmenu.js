/**
 * Front end — the menu that is on screen BEFORE any 3D exists.
 *
 * This is plain DOM on purpose. Nothing here touches THREE, the engine, the
 * renderer or a WebGL context, so it paints on the browser's first frame while
 * the ~12-25 s of procedural generation and shader compilation has not started
 * yet. Booting the engine first and drawing a menu afterwards is what produced
 * the "black screen for half a minute and then a frozen tab" experience.
 *
 * THE LOADING BAR IS ANIMATED WITH `transform`, DELIBERATELY.
 * Level build and shader translation block the main thread solid — a bar driven
 * by rAF or by width/left would freeze at its first frame and look hung. A CSS
 * animation on `transform` runs on the compositor, so it keeps moving while the
 * main thread is wedged. It is an indeterminate barber-pole rather than a real
 * percentage for the same reason: progress callbacks cannot be delivered from a
 * thread that is not running.
 */

export const MAPS = [
  {
    id: 'street',
    name: 'Market Street',
    blurb: 'Full production map — buildings, interiors, props. Slow to load.',
  },
  {
    id: 'swat',
    name: 'Shoot House',
    blurb: 'Close-quarters kill house — six rooms off one corridor. Loads fast.',
  },
  {
    id: 'box',
    name: 'Whitebox Arena',
    blurb: 'Greybox testbed. Loads about twice as fast.',
  },
];

export const MODES = [
  { id: 'tdm', name: 'Team Deathmatch', blurb: 'Two enemy squads garrison the level.' },
  { id: 'sandbox', name: 'Free Roam', blurb: 'No enemies. For testing movement and weapons.' },
];

const CSS = `
.ow-fe{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:2.2rem;
  background:radial-gradient(120% 90% at 50% 0%,#243040 0%,#0d1116 60%,#05070a 100%);
  color:#e8eaed;font:400 15px/1.5 "Inter","Helvetica Neue",Arial,sans-serif;
  letter-spacing:.02em;user-select:none}
.ow-fe h1{font-size:clamp(28px,5vw,54px);font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;color:#fff;text-shadow:0 2px 30px rgba(90,160,255,.25)}
.ow-fe h1 span{display:block;font-size:.28em;letter-spacing:.42em;font-weight:400;
  color:#7d8896;margin-top:.6em}
.ow-fe .ow-cols{display:flex;gap:2.5rem;flex-wrap:wrap;justify-content:center}
.ow-fe .ow-col{min-width:270px}
.ow-fe h2{font-size:11px;letter-spacing:.28em;text-transform:uppercase;
  color:#6f7a88;margin-bottom:.85rem;font-weight:600}
.ow-fe button{display:block;width:100%;text-align:left;margin-bottom:.5rem;
  padding:.7rem .9rem;border:1px solid #2a3442;border-radius:6px;
  background:#151b23;color:#c9d1d9;cursor:pointer;font:inherit;
  transition:border-color .12s,background .12s}
.ow-fe button:hover{background:#1c242e;border-color:#3d4c60}
.ow-fe button[aria-pressed="true"]{background:#1d2b3d;border-color:#5b8ec9;color:#fff}
.ow-fe button b{display:block;font-weight:600;font-size:14px}
.ow-fe button i{display:block;font-style:normal;font-size:11.5px;color:#78828f;margin-top:.15rem}
.ow-fe .ow-play{width:auto;padding:.85rem 3.4rem;text-align:center;font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;background:#2f6fb5;border-color:#4d8ad0;color:#fff}
.ow-fe .ow-play:hover{background:#3b82cf}
.ow-fe .ow-foot{font-size:11px;color:#5b6472}
.ow-load{gap:1.4rem}
.ow-load .ow-bar{width:min(420px,70vw);height:3px;background:#1b222c;overflow:hidden;border-radius:2px}
.ow-load .ow-bar i{display:block;height:100%;width:38%;border-radius:2px;
  background:linear-gradient(90deg,transparent,#5b9ae0,transparent);
  animation:ow-slide 1.15s linear infinite}
@keyframes ow-slide{from{transform:translateX(-110%)}to{transform:translateX(370%)}}
.ow-load .ow-what{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#6f7a88}
`;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/**
 * Paint the menu and resolve with the player's choice once they hit Play.
 * @param {{map?:string, mode?:string}} initial  pre-selection from the URL
 * @returns {Promise<{map:string, mode:string}>}
 */
export function showMainMenu(initial = {}) {
  // The menu is re-shown after every Exit, and a <style> per visit would pile
  // identical sheets into <head> for as long as the session lasts.
  if (!document.getElementById('ow-fe-style')) {
    const style = document.createElement('style');
    style.id = 'ow-fe-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  let map = MAPS.some((m) => m.id === initial.map) ? initial.map : MAPS[0].id;
  let mode = MODES.some((m) => m.id === initial.mode) ? initial.mode : MODES[0].id;

  const list = (items, sel) =>
    items
      .map(
        (o) =>
          `<button type="button" data-id="${o.id}" aria-pressed="${o.id === sel}">
             <b>${o.name}</b><i>${o.blurb}</i>
           </button>`
      )
      .join('');

  const root = el(`
    <div class="ow-fe">
      <h1>Overwatch<span>Tactical Operations</span></h1>
      <div class="ow-cols">
        <div class="ow-col" id="ow-maps"><h2>Map</h2>${list(MAPS, map)}</div>
        <div class="ow-col" id="ow-modes"><h2>Game mode</h2>${list(MODES, mode)}</div>
      </div>
      <button type="button" class="ow-play">Play</button>
      <div class="ow-foot">WASD move · Mouse aim · Shift sprint · R reload · Esc pause</div>
    </div>
  `);
  document.body.appendChild(root);

  const pick = (container, onPick) => {
    container.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      for (const other of container.querySelectorAll('button[data-id]')) {
        other.setAttribute('aria-pressed', String(other === b));
      }
      onPick(b.dataset.id);
    });
  };
  pick(root.querySelector('#ow-maps'), (id) => (map = id));
  pick(root.querySelector('#ow-modes'), (id) => (mode = id));

  return new Promise((resolve) => {
    const go = () => {
      root.remove();
      resolve({ map, mode });
    };
    root.querySelector('.ow-play').addEventListener('click', go);
    // Enter plays with whatever is selected.
    addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter' && root.isConnected) go();
      },
      { once: false }
    );
  });
}

/** Full-screen loading state. Returns a handle with `.done()`. */
export function showLoading(mapName) {
  const root = el(`
    <div class="ow-fe ow-load">
      <div class="ow-what">Loading ${mapName}</div>
      <div class="ow-bar"><i></i></div>
      <div class="ow-foot">Generating textures, geometry and shaders — nothing is downloaded.</div>
    </div>
  `);
  document.body.appendChild(root);
  return {
    /** Fraction 0..1. Purely advisory; the bar also animates on its own. */
    setProgress(value) {
      const f = Math.max(0, Math.min(1, Number(value) || 0));
      const i = root.querySelector('.ow-bar > i');
      if (i) i.style.setProperty('--p', String(f));
    },
    done() {
      root.remove();
    },
  };
}
