/**
 * Drive the pause menu through every path and prove the state machine closes.
 *
 *   node tools/pause-check.mjs [url]
 *
 * Boots through the FRONT MENU (not a ?map= deep link) because the thing under
 * test is the lifecycle: pause -> settings -> back -> resume -> exit -> front
 * menu -> play again. The last step is the one that matters: a second match on
 * the same page is where a canvas or listener left behind turns into a black
 * screen.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = 'shots/pause';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
p.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});

const step = (n, ok, extra = '') => console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
let failures = 0;
const expect = (n, ok, extra) => {
  step(n, ok, extra);
  if (!ok) failures++;
};

await p.goto(URL, { waitUntil: 'domcontentloaded' });

// ---- front menu ---------------------------------------------------------
await p.waitForSelector('.ow-fe .ow-play', { timeout: 30000 });
expect('front menu painted', true);

await p.click('.ow-fe .ow-play');
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(1500);
expect('first match booted', true);

// ---- pause --------------------------------------------------------------
/**
 * A real tap: keydown AND keyup.
 *
 * `Input.actionPressed` is edge-triggered off `_pressed`, which only fills when
 * the key is not already in `down` — so a synthetic keydown with no keyup holds
 * Escape down forever and every later press is a no-op. The first version of
 * this test failed on exactly that and blamed the menu.
 */
const pressEsc = () =>
  p.evaluate(() => {
    for (const type of ['keydown', 'keyup']) {
      window.dispatchEvent(new KeyboardEvent(type, { code: 'Escape', key: 'Escape' }));
    }
  });
const menuState = () =>
  p.evaluate(() => {
    const e = window.__ENGINE__;
    const m = e?.ctx.peek('ui')?.menu;
    const vis = (sel) => {
      const n = document.querySelector(sel);
      return !!n && n.style.display !== 'none';
    };
    return {
      open: !!m?.open,
      page: m?.page,
      title: document.querySelector('.ow-menu h1')?.textContent,
      rootVisible: vis('.ow-page'),
      scale: e?.ctx.peek('ui')?.ctx.time.scale,
      buttons: [...document.querySelectorAll('.ow-menu .ow-btns-col .ow-btn')].map((b) => b.textContent.trim()),
    };
  });

await pressEsc();
await p.waitForTimeout(400);
let st = await menuState();
expect('escape opens the menu', st.open === true);
expect('opens on the root page', st.page === 'root', `page=${st.page} title=${st.title}`);
expect('three buttons', st.buttons.length === 3, st.buttons.join(' / '));
expect('game time frozen', st.scale === 0, `scale=${st.scale}`);
await p.screenshot({ path: `${OUT}/1-pause-root.png` });

// ---- settings -----------------------------------------------------------
await p.click('.ow-menu .ow-btns-col .ow-btn:nth-child(2)');
await p.waitForTimeout(350);
st = await menuState();
expect('settings page opens', st.page === 'settings', `title=${st.title}`);
expect('settings has rows', (await p.locator('.ow-menu .ow-row').count()) > 8,
  `${await p.locator('.ow-menu .ow-row').count()} rows`);
await p.screenshot({ path: `${OUT}/2-settings.png` });

// Escape from a submenu goes back a level, it does not resume the match.
await pressEsc();
await p.waitForTimeout(350);
st = await menuState();
expect('escape in settings returns to root', st.open === true && st.page === 'root', `page=${st.page}`);

// ---- resume -------------------------------------------------------------
await p.click('.ow-menu .ow-btns-col .ow-btn:nth-child(1)');
await p.waitForTimeout(400);
st = await menuState();
expect('play closes the menu', st.open === false);
expect('game time restored', st.scale === 1, `scale=${st.scale}`);

// ---- exit to menu -------------------------------------------------------
await pressEsc();
await p.waitForTimeout(400);
await p.click('.ow-menu .ow-btns-col .ow-btn:nth-child(3)');
await p.waitForFunction('!!document.querySelector(".ow-fe .ow-play")', null, { timeout: 30000 });
const afterExit = await p.evaluate(() => ({
  engine: !!window.__ENGINE__,
  ready: window.__READY__,
  menus: document.querySelectorAll('.ow-menu').length,
  huds: document.querySelectorAll('.ow-hud').length,
  canvases: document.querySelectorAll('canvas#game').length,
  styles: document.querySelectorAll('style#ow-fe-style').length,
}));
expect('front menu is back', true);
expect('engine torn down', afterExit.engine === false);
expect('pause overlay gone', afterExit.menus === 0, `${afterExit.menus} left`);
expect('HUD gone', afterExit.huds === 0, `${afterExit.huds} left`);
expect('exactly one canvas', afterExit.canvases === 1, `${afterExit.canvases} canvases`);
expect('one front-menu stylesheet', afterExit.styles === 1, `${afterExit.styles} sheets`);
await p.screenshot({ path: `${OUT}/3-back-at-front-menu.png` });

// ---- and a second match, on the same page ------------------------------
await p.click('.ow-fe .ow-play');
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(1500);
const second = await p.evaluate(() => {
  const r = window.__ENGINE__?.ctx.peek('render');
  const gl = r?.renderer?.getContext?.();
  return { hasRenderer: !!r, drawing: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null, frame: window.__ENGINE__?.time.frame };
});
expect('second match boots', second.hasRenderer === true, `frame=${second.frame} ${second.drawing}`);
await p.screenshot({ path: `${OUT}/4-second-match.png` });

console.log(`\n${failures} failure(s)`);
if (errors.length) console.log(`page errors:\n  ${errors.slice(0, 6).join('\n  ')}`);
await b.close();
process.exit(failures ? 1 : 0);
