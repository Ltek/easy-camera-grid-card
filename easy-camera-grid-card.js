// Easy Camera Grid Card (Ltek) — Home Assistant Dashboard card: one large live camera + a grid of snapshots
// Version: v2026.11.18.2
//
// One camera plays live in the large pane (Home Assistant's own ha-camera-stream: WebRTC, HLS or MJPEG,
// whatever the camera offers). Every other camera is a tile in the grid. A tile is a JPEG snapshot from
// /api/camera_proxy, reloaded every refresh_seconds (or, per camera, a live stream). Tapping a tile moves
// that camera into the large pane; the camera that was there goes back to its place in the grid.
//
// Only the large pane (and any tile set to live) streams video, so the browser decodes one video
// instead of one per camera. Snapshots are asked for at the size the tile is drawn (width / height on
// the camera_proxy URL), only one at a time per tile, and never while the card or the page is hidden.
//
// Layout: landscape puts the large pane left or right of the grid, portrait above or below it. Each
// orientation has its own pane size, grid columns and rows. orientation: auto follows the screen
// (it changes live when the tablet is turned). height: fill sizes the card to the rest of the screen.
//
// Vanilla JS, single file. The card stylesheet is a constant (no config values are interpolated into
// it); per-card values are custom properties set inline on the card root. Names are escaped.

const BUILD_NUMBER = 'v2026.11.18.2';
const VERSION = BUILD_NUMBER.slice(1);
const CARD_TAG = 'easy-camera-grid-card';
const EDITOR_TAG = 'easy-camera-grid-card-editor';
const STREAM_TAG = 'ha-camera-stream';

const TILE_MODES = ['snapshot', 'live'];
const FITS = ['cover', 'contain', 'fill'];
const ORIENTATIONS = ['auto', 'landscape', 'portrait'];

const DEFAULTS = {
  main_camera: '',          // camera that starts in the large pane ('' = the first one)
  tile_mode: 'snapshot',    // default for every tile: snapshot | live
  refresh_seconds: 2,       // default snapshot refresh
  tile_fit: 'cover',
  main_fit: 'contain',
  muted: true,              // large pane audio
  show_names: true,         // name on each tile
  show_main_name: true,     // name + LIVE badge on the large pane
  reset_after: 0,           // seconds without a touch before going back to main_camera; 0 = off
  orientation: 'auto',
  height: 'fill',           // 'fill' (rest of the screen) or a CSS length (600px, 70vh)
  gap: 6,                   // px between pane and tiles
  landscape: { main_position: 'left', main_size: 60, columns: 3, rows: 0 },
  portrait: { main_position: 'top', main_size: 45, columns: 3, rows: 0 },
};
const POSITIONS = { landscape: ['left', 'right'], portrait: ['top', 'bottom'] };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

/** Config with every default filled in. Cameras may be given as strings or { entity, ... }. */
function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS, ...raw };
  c.cameras = (Array.isArray(raw.cameras) ? raw.cameras : [])
    .map((x) => (typeof x === 'string' ? { entity: x } : { ...(x || {}) }))
    .filter((x) => typeof x.entity === 'string' && x.entity.trim())
    .map((x) => {
      const cam = { entity: x.entity.trim() };
      if (x.name) cam.name = String(x.name);
      if (TILE_MODES.includes(x.tile_mode)) cam.tile_mode = x.tile_mode;
      if (x.refresh_seconds !== undefined && x.refresh_seconds !== '' && Number.isFinite(Number(x.refresh_seconds))) {
        cam.refresh_seconds = clamp(x.refresh_seconds, 0.5, 3600, DEFAULTS.refresh_seconds);
      }
      if (FITS.includes(x.fit)) cam.fit = x.fit;
      return cam;
    });
  c.tile_mode = oneOf(c.tile_mode, TILE_MODES, DEFAULTS.tile_mode);
  c.refresh_seconds = clamp(c.refresh_seconds, 0.5, 3600, DEFAULTS.refresh_seconds);
  c.tile_fit = oneOf(c.tile_fit, FITS, DEFAULTS.tile_fit);
  c.main_fit = oneOf(c.main_fit, FITS, DEFAULTS.main_fit);
  c.orientation = oneOf(c.orientation, ORIENTATIONS, 'auto');
  c.reset_after = clamp(c.reset_after, 0, 86400, 0);
  c.gap = clamp(c.gap, 0, 40, DEFAULTS.gap);
  c.muted = c.muted !== false;
  c.show_names = c.show_names !== false;
  c.show_main_name = c.show_main_name !== false;
  c.height = typeof c.height === 'string' && c.height.trim() ? c.height.trim() : (typeof c.height === 'number' ? `${c.height}px` : 'fill');
  for (const o of ['landscape', 'portrait']) {
    const d = DEFAULTS[o], v = { ...d, ...(raw[o] || {}) };
    c[o] = {
      main_position: oneOf(v.main_position, POSITIONS[o], d.main_position),
      main_size: clamp(v.main_size, 10, 90, d.main_size),
      columns: Math.round(clamp(v.columns, 1, 12, d.columns)),
      rows: Math.round(clamp(v.rows, 0, 12, 0)),
    };
  }
  if (!c.cameras.some((x) => x.entity === c.main_camera)) c.main_camera = c.cameras[0]?.entity || '';
  return c;
}

/** What a tile of this camera does: mode, refresh, fit (camera setting, else the card default). */
function tileSettings(cfg, cam) {
  return {
    mode: cam.tile_mode || cfg.tile_mode,
    refresh: cam.refresh_seconds ?? cfg.refresh_seconds,
    fit: cam.fit || cfg.tile_fit,
  };
}

/** Cameras in the grid: every camera except the one in the large pane, in config order. */
const gridCameras = (cfg, mainId) => cfg.cameras.filter((c) => c.entity !== mainId);

/** Layout for an orientation. rows 0 = as many as the tiles need. */
function layoutFor(cfg, orientation, tileCount) {
  const l = cfg[orientation];
  const rows = l.rows || Math.max(1, Math.ceil(tileCount / l.columns));
  return { ...l, rows };
}

const resolveOrientation = (cfg, portraitScreen) =>
  (cfg.orientation === 'auto' ? (portraitScreen ? 'portrait' : 'landscape') : cfg.orientation);

const isUnavailable = (st) => !st || st.state === 'unavailable' || st.state === 'unknown';

/** Snapshot URL for a camera state at a pixel size, with a cache-buster. null when there is none. */
function snapshotUrl(hass, stateObj, width, height, now = Date.now()) {
  const pic = stateObj?.attributes?.entity_picture;
  if (!pic) return null;
  let url = pic + (pic.includes('?') ? '&' : '?');
  if (width > 0 && height > 0) url += `width=${Math.round(width)}&height=${Math.round(height)}&`;
  url += `_t=${now}`;
  return hass && typeof hass.hassUrl === 'function' ? hass.hassUrl(url) : url;
}

/** Text over a tile: missing entity, unavailable camera, or a snapshot that failed. '' = none. */
function tileMessage(st, entity, failed) {
  if (!st) return `${entity} not found`;
  if (isUnavailable(st)) return 'Unavailable';
  return failed ? 'No picture' : '';
}

const camName = (hass, cam) => cam.name || hass?.states?.[cam.entity]?.attributes?.friendly_name || cam.entity;

/** Make sure HA's lazy-loaded ha-camera-stream element is defined (it loads with the picture-entity card). */
let streamReady = null;
function ensureStreamElement(sampleEntity) {
  if (customElements.get(STREAM_TAG)) return Promise.resolve(true);
  if (!streamReady) {
    streamReady = (async () => {
      try {
        if (typeof window.loadCardHelpers === 'function') {
          const helpers = await window.loadCardHelpers();
          helpers.createCardElement({ type: 'picture-entity', entity: sampleEntity, camera_view: 'live' });
        }
      } catch (_e) { /* the timeout below reports it */ }
      return Promise.race([
        customElements.whenDefined(STREAM_TAG).then(() => true),
        new Promise((r) => setTimeout(() => r(false), 10000)),
      ]);
    })();
  }
  return streamReady;
}

const CARD_CSS = `
:host { display: block; }
ha-card { overflow: hidden; height: 100%; }
.root { display: grid; gap: var(--ecg-gap); height: var(--ecg-height); min-height: 200px; box-sizing: border-box; padding: var(--ecg-gap); }
.root.landscape { grid-template-columns: var(--ecg-a) var(--ecg-b); grid-template-rows: 100%; }
.root.portrait { grid-template-rows: var(--ecg-a) var(--ecg-b); grid-template-columns: 100%; }
.main, .grid { min-width: 0; min-height: 0; }
.root.swap .main { order: 2; }
.main { position: relative; background: #000; border-radius: 8px; overflow: hidden; cursor: default; }
.main > .poster, .main > ha-camera-stream { position: absolute; inset: 0; width: 100%; height: 100%; }
.main > .poster { object-fit: var(--ecg-main-fit); }
.main > .poster:not([src]) { display: none; }
.main ha-camera-stream { --video-max-height: 100%; display: block; }
.main.loaded > .poster { visibility: hidden; }
.label { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 6px; align-items: center; pointer-events: none;
  font-size: 13px; font-weight: 500; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.8); z-index: 2; }
.badge { background: #d32f2f; color: #fff; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 700; letter-spacing: .5px; text-shadow: none; }
.grid { display: grid; gap: var(--ecg-gap); grid-template-columns: repeat(var(--ecg-cols), minmax(0, 1fr));
  grid-auto-rows: calc((100% - (var(--ecg-rows) - 1) * var(--ecg-gap)) / var(--ecg-rows)); overflow-y: auto; }
.tile { display: block; width: 100%; height: 100%; font: inherit; position: relative; background: #111; border-radius: 6px; overflow: hidden; cursor: pointer; padding: 0; border: 0;
  -webkit-tap-highlight-color: transparent; }
.tile:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); }
.tile img, .tile ha-camera-stream { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: var(--fit, cover); pointer-events: none; }
.tile .label { left: 6px; bottom: 4px; font-size: 12px; }
.msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 12px; text-align: center; padding: 4px; }
.warn { padding: 16px; color: var(--error-color, #db4437); }
`;

class EasyCameraGridCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._tiles = new Map();      // entity → { el, img, timer, busy, url }
    this._mainId = '';
    this._stream = null;
    this._visible = true;
    this._resetTimer = null;
    this._onResize = () => this._applyLayout();
    this._onVisibility = () => this._setVisible(!document.hidden && this._inView !== false);
  }

  static getConfigElement() { return document.createElement(EDITOR_TAG); }

  static getStubConfig(hass) {
    const cams = Object.keys(hass?.states || {}).filter((id) => id.startsWith('camera.')).slice(0, 6);
    return { cameras: cams.length ? cams : ['camera.example'] };
  }

  getCardSize() { return 8; }

  getGridOptions() { return { columns: 'full', rows: 'auto' }; }

  setConfig(config) {
    if (!config || !Array.isArray(config.cameras) || !config.cameras.length) throw new Error('Add at least one camera under cameras:');
    const cfg = normalizeConfig(config);
    if (!cfg.cameras.length) throw new Error('Every camera needs an entity, like camera.front_door');
    const changed = JSON.stringify(cfg) !== JSON.stringify(this._config);
    this._config = cfg;
    if (!changed) return;
    this._mainId = cfg.main_camera;
    if (this._hass) this._build();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (first || !this._root) { this._build(); return; }
    this._refreshStates();
  }

  get hass() { return this._hass; }

  connectedCallback() {
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
    if (window.matchMedia) {
      this._mq = window.matchMedia('(orientation: portrait)');
      this._mqListener = () => this._applyLayout();
      if (this._mq.addEventListener) this._mq.addEventListener('change', this._mqListener);
    }
    if (typeof IntersectionObserver === 'function') {
      this._io = new IntersectionObserver((entries) => {
        this._inView = entries.some((e) => e.isIntersecting);
        this._onVisibility();
      });
      this._io.observe(this);
    }
    if (this._config && this._hass) { if (!this._root) this._build(); else { this._applyLayout(); this._setVisible(!document.hidden); } }
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._mq && this._mq.removeEventListener) this._mq.removeEventListener('change', this._mqListener);
    if (this._io) { this._io.disconnect(); this._io = null; }
    this._setVisible(false);
    clearTimeout(this._resetTimer);
  }

  // ---------------------------------------------------------------- building
  _build() {
    const cfg = this._config;
    this._stopAll();
    this._tiles.clear();
    this._stream = null;
    this.shadowRoot.innerHTML = `<style>${CARD_CSS}</style><ha-card><div class="root">
      <div class="main"><img class="poster" alt=""><div class="label"></div></div><div class="grid"></div></div></ha-card>`;
    this._root = this.shadowRoot.querySelector('.root');
    this._main = this.shadowRoot.querySelector('.main');
    this._grid = this.shadowRoot.querySelector('.grid');
    this._root.style.setProperty('--ecg-gap', `${cfg.gap}px`);
    this._root.style.setProperty('--ecg-main-fit', cfg.main_fit);
    this._root.addEventListener('pointerdown', () => this._touched(), { passive: true });
    this._grid.addEventListener('click', (ev) => {
      const tile = ev.target.closest('.tile');
      if (tile) this.promote(tile.dataset.entity);
    });
    for (const cam of cfg.cameras) this._tiles.set(cam.entity, this._makeTile(cam));
    this._placeTiles();
    this._visible = false;          // poster + label now; the stream starts in _setVisible
    this._showMain();
    this._applyLayout();
    this._setVisible(!document.hidden && this._inView !== false);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this._applyLayout());
  }

  _makeTile(cam) {
    const el = document.createElement('button');
    el.className = 'tile';
    el.type = 'button';
    el.dataset.entity = cam.entity;
    const s = tileSettings(this._config, cam);
    el.style.setProperty('--fit', s.fit);
    el.innerHTML = `${s.mode === 'snapshot' ? '<img alt="" decoding="async">' : ''}<div class="msg"></div>${
      this._config.show_names ? '<div class="label"></div>' : ''}`;
    const t = { cam, el, img: el.querySelector('img'), msg: el.querySelector('.msg'), timer: null, busy: false, mode: s.mode, refresh: s.refresh, stream: null, failed: false };
    this._paintTile(t);
    return t;
  }

  _paintTile(t) {
    const st = this._hass?.states?.[t.cam.entity];
    const name = camName(this._hass, t.cam);
    t.el.title = name;
    t.el.setAttribute('aria-label', `Show ${name} live`);
    const label = t.el.querySelector('.label');
    if (label) label.textContent = name;
    t.msg.textContent = tileMessage(st, t.cam.entity, t.failed);
    t.msg.style.display = t.msg.textContent ? '' : 'none';
  }

  /** Put the grid tiles in config order, without the camera that is in the large pane. */
  _placeTiles() {
    const want = gridCameras(this._config, this._mainId).map((c) => this._tiles.get(c.entity).el);
    const kids = [...this._grid.children];
    if (kids.length === want.length && kids.every((k, i) => k === want[i])) return;
    for (const k of kids) if (!want.includes(k)) k.remove();
    want.forEach((el, i) => { if (this._grid.children[i] !== el) this._grid.insertBefore(el, this._grid.children[i] || null); });
  }

  /** Large pane: start the live stream for the current main camera (one stream at a time). */
  async _showMain() {
    const cfg = this._config, id = this._mainId;
    const cam = cfg.cameras.find((c) => c.entity === id);
    const label = this._main.querySelector('.label');
    label.innerHTML = cfg.show_main_name && cam ? `<span>${esc(camName(this._hass, cam))}</span><span class="badge">LIVE</span>` : '';
    if (this._stream) { this._stream.remove(); this._stream = null; }
    this._main.classList.remove('loaded');
    const poster = this._main.querySelector('.poster');
    const tile = this._tiles.get(id);
    const src = tile?.img?.getAttribute('src') || snapshotUrl(this._hass, this._hass?.states?.[id], 0, 0);
    if (src) poster.src = src; else poster.removeAttribute('src');
    if (!this._visible || !cam) return;
    const ok = await ensureStreamElement(id);
    if (!ok || this._mainId !== id || !this._visible || this._stream) return;
    const s = document.createElement(STREAM_TAG);
    s.hass = this._hass;
    s.stateObj = this._hass?.states?.[id];
    s.muted = cfg.muted;
    s.controls = false;
    s.fitMode = cfg.main_fit;
    s.addEventListener('load', () => this._main.classList.add('loaded'));
    s.addEventListener('streams', () => this._main.classList.add('loaded'));
    this._stream = s;
    this._main.appendChild(s);
  }

  /** Move a camera into the large pane; the one there goes back to its grid spot. */
  promote(entity) {
    if (!entity || entity === this._mainId || !this._tiles.has(entity)) return;
    this._mainId = entity;
    this._placeTiles();
    for (const t of this._tiles.values()) {
      const inGrid = t.cam.entity !== entity;
      if (t.mode === 'live') this._tileStream(t, inGrid && this._visible);
      else if (inGrid && this._visible && !t.timer && !t.busy) this._loadSnapshot(t);
    }
    this._showMain();
    this._applyLayout();
    this._armReset();
    this.dispatchEvent(new CustomEvent('easy-camera-grid-changed', { detail: { entity }, bubbles: true, composed: true }));
  }

  // ---------------------------------------------------------------- layout
  _applyLayout() {
    if (!this._root) return;
    const cfg = this._config;
    const portraitScreen = window.matchMedia ? window.matchMedia('(orientation: portrait)').matches : window.innerHeight > window.innerWidth;
    const o = resolveOrientation(cfg, portraitScreen);
    const l = layoutFor(cfg, o, Math.max(0, cfg.cameras.length - 1));
    const r = this._root;
    r.classList.toggle('landscape', o === 'landscape');
    r.classList.toggle('portrait', o === 'portrait');
    r.classList.toggle('swap', l.main_position === 'right' || l.main_position === 'bottom');
    const a = `${l.main_size}%`, b = 'minmax(0, 1fr)';
    const swap = r.classList.contains('swap');
    r.style.setProperty('--ecg-a', swap ? b : `calc(${a} - var(--ecg-gap) / 2)`);
    r.style.setProperty('--ecg-b', swap ? `calc(${a} - var(--ecg-gap) / 2)` : b);
    this._grid.style.setProperty('--ecg-cols', l.columns);
    this._grid.style.setProperty('--ecg-rows', l.rows);
    r.style.setProperty('--ecg-height', this._height());
    this._orientation = o;
  }

  _height() {
    const h = this._config.height;
    if (h !== 'fill') return h;
    const top = this.getBoundingClientRect ? this.getBoundingClientRect().top : 0;
    const avail = (window.innerHeight || 800) - Math.max(0, top) - 8;
    return `${Math.max(200, Math.round(avail))}px`;
  }

  // ---------------------------------------------------------------- refresh
  _refreshStates() {
    for (const t of this._tiles.values()) this._paintTile(t);
    if (this._stream) {
      const st = this._hass.states[this._mainId];
      this._stream.hass = this._hass;
      if (st && st !== this._stream.stateObj) this._stream.stateObj = st;
    }
    for (const t of this._tiles.values()) if (t.stream) t.stream.hass = this._hass;
  }

  _setVisible(v) {
    if (v === this._visible) return;
    this._visible = v;
    if (!this._root) return;
    if (!v) { this._stopAll(); return; }
    this._applyLayout();
    for (const t of this._tiles.values()) {
      if (t.cam.entity === this._mainId) continue;
      if (t.mode === 'live') this._tileStream(t, true);
      else this._loadSnapshot(t);
    }
    this._showMain();
  }

  _stopAll() {
    for (const t of this._tiles.values()) {
      clearTimeout(t.timer); t.timer = null;
      if (t.stream) { t.stream.remove(); t.stream = null; }
    }
    if (this._stream) { this._stream.remove(); this._stream = null; }
  }

  _loadSnapshot(t) {
    clearTimeout(t.timer); t.timer = null;
    if (!this._visible || t.cam.entity === this._mainId || !t.img) return;
    const st = this._hass?.states?.[t.cam.entity];
    const box = t.el.getBoundingClientRect ? t.el.getBoundingClientRect() : { width: 0, height: 0 };
    const dpr = window.devicePixelRatio || 1;
    const url = isUnavailable(st) ? null : snapshotUrl(this._hass, st, box.width * dpr, box.height * dpr);
    const next = () => { t.busy = false; if (this._visible && t.cam.entity !== this._mainId) t.timer = setTimeout(() => this._loadSnapshot(t), t.refresh * 1000); };
    if (!url) { next(); return; }
    t.busy = true;
    const pre = new Image();
    pre.onload = () => { t.img.src = url; this._setFailed(t, false); next(); };
    pre.onerror = () => { this._setFailed(t, true); next(); };
    pre.src = url;
  }

  /** A snapshot that won't load says so on the tile (and keeps retrying), instead of staying blank. */
  _setFailed(t, failed) {
    if (t.failed === failed) return;
    t.failed = failed;
    if (failed && t.img) t.img.removeAttribute('src');
    this._paintTile(t);
  }

  _tileStream(t, on) {
    if (!on) { if (t.stream) { t.stream.remove(); t.stream = null; } return; }
    if (t.stream) return;
    ensureStreamElement(t.cam.entity).then((ok) => {
      if (!ok || t.stream || !this._visible || t.cam.entity === this._mainId) return;
      const s = document.createElement(STREAM_TAG);
      s.hass = this._hass;
      s.stateObj = this._hass?.states?.[t.cam.entity];
      s.muted = true;
      s.controls = false;
      s.fitMode = tileSettings(this._config, t.cam).fit;
      t.stream = s;
      t.el.prepend(s);
    });
  }

  // ---------------------------------------------------------------- reset
  _touched() { this._armReset(); }

  _armReset() {
    clearTimeout(this._resetTimer);
    const secs = this._config.reset_after;
    if (!secs || this._mainId === this._config.main_camera) return;
    this._resetTimer = setTimeout(() => this.promote(this._config.main_camera), secs * 1000);
  }
}

// =================================================================== editor
const EDITOR_CSS = `
:host { display: block; }
details { border: 1px solid var(--divider-color, #ccc); border-radius: 8px; margin: 8px 0; }
summary { padding: 10px 12px; cursor: pointer; font-weight: 500; display: flex; gap: 8px; align-items: center; }
.body { padding: 4px 12px 12px; }
.row { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
.row > label.lbl { min-width: 150px; color: var(--secondary-text-color); }
input[type=text], input[type=number], select { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--divider-color, #ccc);
  background: var(--card-background-color, #fff); color: var(--primary-text-color); font: inherit; }
input[type=number] { width: 80px; }
.cam { border: 1px solid var(--divider-color, #ccc); border-radius: 8px; padding: 8px; margin: 6px 0; }
.cam .head { display: flex; gap: 6px; align-items: center; }
.cam .head input { flex: 1; min-width: 0; }
button { cursor: pointer; border: 1px solid var(--divider-color, #ccc); border-radius: 6px; background: transparent;
  color: var(--primary-text-color); padding: 4px 8px; font: inherit; }
button:disabled { opacity: .35; cursor: default; }
.muted { color: var(--secondary-text-color); font-size: 12px; }
.foot { margin-top: 12px; font-size: 12px; color: var(--secondary-text-color); display: flex; gap: 12px; flex-wrap: wrap; }
.foot a { color: var(--primary-color); }
`;

class EasyCameraGridCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._open = new Set(['cameras']);
  }

  setConfig(config) {
    const changed = JSON.stringify(config) !== JSON.stringify(this._config);
    this._config = JSON.parse(JSON.stringify(config || {}));
    if (changed || !this._rendered) this._render();
  }

  set hass(hass) { const first = !this._hass; this._hass = hass; if (first) this._render(); }

  _emit() {
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  /** Set a top-level or nested (landscape.columns) key; '' / default removes it. */
  _set(path, value) {
    const [a, b] = path.split('.');
    if (b) {
      const obj = { ...(this._config[a] || {}) };
      if (value === '' || value === undefined || value === DEFAULTS[a][b]) delete obj[b]; else obj[b] = value;
      if (Object.keys(obj).length) this._config[a] = obj; else delete this._config[a];
    } else if (value === '' || value === undefined || value === DEFAULTS[a]) delete this._config[a];
    else this._config[a] = value;
    this._emit();
  }

  _cams() { return (this._config.cameras || []).map((x) => (typeof x === 'string' ? { entity: x } : { ...x })); }

  _setCams(list) {
    this._config.cameras = list.map((c) => {
      const keys = Object.keys(c).filter((k) => c[k] !== '' && c[k] !== undefined);
      return keys.length === 1 && keys[0] === 'entity' ? c.entity : Object.fromEntries(keys.map((k) => [k, c[k]]));
    });
    this._emit();
    this._render();
  }

  _val(path) {
    const n = normalizeConfig(this._config);
    const [a, b] = path.split('.');
    return b ? n[a][b] : n[a];
  }

  _sel(path, label, opts) {
    const cur = String(this._val(path));
    return `<div class="row"><label class="lbl">${label}</label><select data-path="${path}">${
      opts.map(([v, n]) => `<option value="${esc(v)}"${String(v) === cur ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`;
  }

  _num(path, label, min, max, step = 1, hint = '') {
    return `<div class="row"><label class="lbl">${label}</label><input type="number" data-path="${path}" data-num="1" min="${min}" max="${max}" step="${step}" value="${esc(this._val(path))}">${
      hint ? `<span class="muted">${hint}</span>` : ''}</div>`;
  }

  _chk(path, label) {
    return `<div class="row"><label><input type="checkbox" data-path="${path}" data-bool="1"${this._val(path) ? ' checked' : ''}> ${label}</label></div>`;
  }

  _panel(id, title, body) {
    return `<details data-panel="${id}"${this._open.has(id) ? ' open' : ''}><summary>${title}</summary><div class="body">${body}</div></details>`;
  }

  _render() {
    this._rendered = true;
    const cams = this._cams();
    const camIds = Object.keys(this._hass?.states || {}).filter((id) => id.startsWith('camera.')).sort();
    const nameOf = (c) => camName(this._hass, c);
    const camRows = cams.map((c, i) => `<div class="cam" data-i="${i}">
      <div class="head"><input type="text" data-cam="${i}" data-field="entity" list="ecg-cams" value="${esc(c.entity)}" placeholder="camera.front_door">
        <button data-move="${i}" data-dir="-1" title="Move up"${i === 0 ? ' disabled' : ''}>▲</button>
        <button data-move="${i}" data-dir="1" title="Move down"${i === cams.length - 1 ? ' disabled' : ''}>▼</button>
        <button data-del="${i}" title="Remove">✕</button></div>
      <div class="row"><label class="lbl">Name</label><input type="text" data-cam="${i}" data-field="name" value="${esc(c.name || '')}" placeholder="${esc(nameOf({ entity: c.entity }))}"></div>
      <div class="row"><label class="lbl">Tile</label><select data-cam="${i}" data-field="tile_mode">${
        [['', 'Card default'], ['snapshot', 'JPEG snapshot'], ['live', 'Live stream']].map(([v, n]) => `<option value="${v}"${(c.tile_mode || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="row"><label class="lbl">Snapshot every (s)</label><input type="number" min="0.5" step="0.5" data-cam="${i}" data-field="refresh_seconds" value="${esc(c.refresh_seconds ?? '')}" placeholder="card default"></div>
      <div class="row"><label class="lbl">Tile fit</label><select data-cam="${i}" data-field="fit">${
        [['', 'Card default'], ['cover', 'Fill tile (crop)'], ['contain', 'Whole picture'], ['fill', 'Stretch']].map(([v, n]) => `<option value="${v}"${(c.fit || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>`).join('');
    const fitOpts = [['cover', 'Fill (crop)'], ['contain', 'Whole picture'], ['fill', 'Stretch']];
    const layout = (o, posOpts) => this._sel(`${o}.main_position`, 'Large pane', posOpts)
      + this._num(`${o}.main_size`, 'Large pane size (%)', 10, 90)
      + this._num(`${o}.columns`, 'Grid columns', 1, 12)
      + this._num(`${o}.rows`, 'Grid rows', 0, 12, 1, '0 = as many as needed');
    this.shadowRoot.innerHTML = `<style>${EDITOR_CSS}</style>
      <datalist id="ecg-cams">${camIds.map((id) => `<option value="${esc(id)}"></option>`).join('')}</datalist>
      ${this._panel('cameras', '📷 Cameras', `<div class="muted">The grid shows the cameras in this order. Each camera can have its own tile settings.</div>
        ${camRows}<div class="row"><button data-add="1">+ Add camera</button></div>
        ${this._sel('main_camera', 'Starts in the large pane', cams.map((c) => [c.entity, nameOf(c)]))}`)}
      ${this._panel('tiles', '🧩 Tiles (defaults for every camera)', this._sel('tile_mode', 'Tile', [['snapshot', 'JPEG snapshot'], ['live', 'Live stream']])
        + this._num('refresh_seconds', 'Snapshot every (s)', 0.5, 3600, 0.5)
        + this._sel('tile_fit', 'Tile fit', fitOpts) + this._chk('show_names', 'Show camera names'))}
      ${this._panel('main', '🎥 Large pane', this._sel('main_fit', 'Fit', fitOpts) + this._chk('muted', 'Muted')
        + this._chk('show_main_name', 'Show name and LIVE badge')
        + this._num('reset_after', 'Go back after (s)', 0, 86400, 1, 'no touch for this long → back to the start camera; 0 = off'))}
      ${this._panel('layout', '📐 Layout', this._sel('orientation', 'Orientation', [['auto', 'Follow the screen'], ['landscape', 'Always landscape'], ['portrait', 'Always portrait']])
        + `<div class="row"><label class="lbl">Height</label><input type="text" data-path="height" value="${esc(this._val('height'))}" placeholder="fill"><span class="muted">fill = rest of the screen, or 600px, 70vh</span></div>`
        + this._num('gap', 'Gap (px)', 0, 40)
        + '<h4>Landscape</h4>' + layout('landscape', [['left', 'Left'], ['right', 'Right']])
        + '<h4>Portrait</h4>' + layout('portrait', [['top', 'Top'], ['bottom', 'Bottom']]))}
      <div class="foot"><span>${BUILD_NUMBER}</span><a href="https://github.com/Ltek/easy-camera-grid-card" target="_blank" rel="noopener">⭐ Star on GitHub</a>
        <a href="https://github.com/Ltek/easy-camera-grid-card/issues" target="_blank" rel="noopener">🐛 Report an issue</a></div>`;
    this._wire();
  }

  _wire() {
    const R = this.shadowRoot, all = (s, f) => R.querySelectorAll(s).forEach(f);
    all('details', (d) => d.addEventListener('toggle', () => { if (d.open) this._open.add(d.dataset.panel); else this._open.delete(d.dataset.panel); }));
    all('[data-path]', (el) => el.addEventListener('change', () => {
      let v = el.dataset.bool ? el.checked : el.value.trim();
      if (el.dataset.num) v = v === '' ? '' : Number(v);
      this._set(el.dataset.path, v);
    }));
    all('[data-cam]', (el) => el.addEventListener('change', () => {
      const cams = this._cams(), c = cams[Number(el.dataset.cam)], f = el.dataset.field;
      let v = el.value.trim();
      if (f === 'refresh_seconds') v = v === '' ? '' : Number(v);
      if (v === '') delete c[f]; else c[f] = v;
      this._setCams(cams);
    }));
    all('[data-move]', (el) => el.addEventListener('click', () => {
      const cams = this._cams(), i = Number(el.dataset.move), j = i + Number(el.dataset.dir);
      if (j < 0 || j >= cams.length) return;
      [cams[i], cams[j]] = [cams[j], cams[i]];
      this._setCams(cams);
    }));
    all('[data-del]', (el) => el.addEventListener('click', () => {
      const cams = this._cams(); cams.splice(Number(el.dataset.del), 1); this._setCams(cams);
    }));
    all('[data-add]', (el) => el.addEventListener('click', () => {
      const cams = this._cams(), used = new Set(cams.map((c) => c.entity));
      const next = Object.keys(this._hass?.states || {}).find((id) => id.startsWith('camera.') && !used.has(id)) || 'camera.';
      cams.push({ entity: next }); this._setCams(cams);
    }));
  }
}

// Test hooks (pure helpers; no effect in the browser)
EasyCameraGridCard._test = {
  BUILD_NUMBER, VERSION, DEFAULTS, CARD_CSS, normalizeConfig, tileSettings, gridCameras, layoutFor,
  resolveOrientation, snapshotUrl, camName, ensureStreamElement, tileMessage,
};

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, EasyCameraGridCard);
if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, EasyCameraGridCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: 'Easy Camera Grid Card (Ltek)',
    description: 'One large live camera plus a grid of refreshing snapshots. Tap a snapshot to make it the live camera.',
    preview: false,
    documentationURL: 'https://github.com/Ltek/easy-camera-grid-card',
  });
}

console.info(`%c EASY-CAMERA-GRID-CARD %c ${BUILD_NUMBER} `, 'color:#fff;background:#2196F3;font-weight:700', 'color:#2196F3;background:transparent');
