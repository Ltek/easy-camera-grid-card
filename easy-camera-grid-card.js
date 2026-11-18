// Easy Camera Grid Card (Ltek) — Home Assistant Dashboard card: one large live camera + a grid of snapshots
// Version: v2026.11.18.4
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

const BUILD_NUMBER = 'v2026.11.18.4';
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

// View state outside the element: the dashboard editor replaces the card element on many edits, and the
// camera you tapped should still be the live one afterwards. Keyed by the camera list.
const VIEW = new Map();
const viewKey = (cfg) => cfg.cameras.map((c) => c.entity).join('|');

// Config keys whose change needs the tiles rebuilt; anything else is patched in place.
const STRUCTURE_KEYS = ['cameras', 'tile_mode', 'show_names', 'muted', 'main_fit', 'show_main_name', 'main_camera'];
const structureOf = (cfg) => JSON.stringify(STRUCTURE_KEYS.map((k) => cfg[k]));

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
    const prev = this._config;
    if (prev && JSON.stringify(cfg) === JSON.stringify(prev)) return;
    this._config = cfg;
    if (prev && this._root && structureOf(prev) === structureOf(cfg)) { this._patch(); return; }
    const v = VIEW.get(viewKey(cfg));
    this._mainId = v && v.start === cfg.main_camera && cfg.cameras.some((c) => c.entity === v.main) ? v.main : cfg.main_camera;
    if (this._hass) this._build();
  }

  /** Layout, refresh, fit or go-back changed: update what's there, keep the stream and the tiles. */
  _patch() {
    const cfg = this._config;
    this._root.style.setProperty('--ecg-gap', `${cfg.gap}px`);
    for (const t of this._tiles.values()) {
      const s = tileSettings(cfg, t.cam = cfg.cameras.find((c) => c.entity === t.cam.entity) || t.cam);
      t.el.style.setProperty('--fit', s.fit);
      if (s.refresh !== t.refresh) { t.refresh = s.refresh; if (t.timer) this._loadSnapshot(t); }
    }
    this._applyLayout();
    this._armReset();
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
    el.innerHTML = `${s.mode === 'snapshot' ? '<img alt="">' : ''}<div class="msg"></div>${
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
    VIEW.set(viewKey(this._config), { main: entity, start: this._config.main_camera });
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
    // Load and decode the next picture off-screen, then swap the finished element in. The old picture
    // stays up until then (no black frame), and the snapshot is downloaded once, not twice.
    const pre = new Image();
    pre.alt = '';
    pre.onload = async () => {
      try { if (typeof pre.decode === 'function') await pre.decode(); } catch (_e) { /* show it anyway */ }
      if (t.img && t.img.parentNode) { t.img.replaceWith(pre); t.img = pre; }
      this._setFailed(t, false);
      next();
    };
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
// Follows CARD_DESIGN_SYSTEM.md: --ltek-* token block (byte-identical to the other Ltek cards), top-level
// panels with an accent border when open, flat uppercase sub-panels, content-width label rows, sliders with
// a bold readout, trash icon for delete, Star + Report footer. Rendered in the light DOM like the other cards.
const EDITOR_CSS = `
        .ecge {
          /* Font sizes (by role, not by pixel) */
          --ltek-fs-panel-title: 16px;  /* top-level panel / section title */
          --ltek-fs-header: 15px;       /* editor header, panel summary */
          --ltek-fs-group: 14px;        /* group heading inside a panel */
          --ltek-fs-label: 13px;        /* standard field label / row */
          --ltek-fs-body: 12px;         /* body text, most controls */
          --ltek-fs-small: 11px;        /* hints, secondary text */
          --ltek-fs-tiny: 10px;         /* badges, micro-labels */
          /* Font weights */
          --ltek-fw-normal: 400;        /* control labels (recede) */
          --ltek-fw-medium: 500;
          --ltek-fw-semibold: 600;
          --ltek-fw-bold: 700;          /* titles, values (lead) */
          /* Text colors */
          --ltek-c-text: var(--primary-text-color, #e1e1e1);  /* primary */
          --ltek-c-label: #ccc;         /* control labels */
          --ltek-c-muted: #888;         /* hints / disabled */
          --ltek-c-accent: var(--primary-color, #2196F3);
          /* Accent tints — hover / active fills (kept as rgba literals; one place
             to change). Default to the Material blue the cards shipped with. */
          --ltek-c-accent-fade: rgba(var(--rgb-primary-color,33,150,243),0.12);       /* active / pressed fill */
          --ltek-c-accent-fade-soft: rgba(var(--rgb-primary-color,33,150,243),0.08);  /* hover fill */
          --ltek-c-error-fade: rgba(244,67,54,0.15);         /* delete hover fill */
          /* Status colors — defer to the user's theme, fall back to Material. */
          --ltek-c-error: var(--error-color, #f44336);
          --ltek-c-success: var(--success-color, #4caf50);
          --ltek-c-warning: var(--warning-color, #ffb300);
          --ltek-c-info: var(--info-color, #2196F3);
          /* Second accent: the green "library / shared" grouping (distinct from
             the blue layout accent on purpose — NOT tied to --primary-color). */
          --ltek-c-accent-lib: #7fd18a;
          --ltek-c-on-accent: #fff;   /* text/icon on a solid accent fill */
          /* Action icons (edit/copy/hide/etc): neutral idle → brighten on hover.
             Delete stays a status color (error) on its own hover. */
          --ltek-c-icon: #aaa;        /* idle action icon */
          --ltek-c-icon-hover: #fff;  /* hovered action icon */
          /* Surfaces */
          --ltek-c-surface: rgba(255,255,255,0.015);        /* panels */
          --ltek-c-surface-raised: rgba(255,255,255,0.02);  /* cards / rows */
          /* Borders */
          --ltek-c-panel-border: #3a3a3a;   /* panels */
          --ltek-c-border: #444;            /* controls */
          --ltek-c-border-soft: #333;       /* subtle inner dividers */
          /* Radii */
          --ltek-r-panel: 12px;   /* panels */
          --ltek-r-card: 10px;    /* section cards */
          --ltek-r-md: 8px;       /* blocks */
          --ltek-r-ctrl: 6px;     /* inputs, selects, buttons */
          /* Spacing scale (4px base) */
          --ltek-sp-1: 4px;
          --ltek-sp-2: 6px;
          --ltek-sp-3: 8px;
          --ltek-sp-4: 10px;
          --ltek-sp-5: 12px;
          --ltek-sp-6: 16px;
          /* Control padding — uniform input/select/button height. */
          --ltek-ctrl-pad: 6px 10px;
          /* Icon sizes (two clear roles; one-off glyphs stay literal). */
          --ltek-icon-sm: 16px;   /* inline / action icons */
          --ltek-icon-lg: 20px;   /* panel-title icons */
          /* Slider row geometry (shared by every slider) */
          --ltek-slider-val-w: 44px;   /* value readout column width */
          display: flex; flex-direction: column; gap: 8px; font-family: var(--paper-font-body1_-_font-family, sans-serif);
        }
        .ecge ha-icon { --mdc-icon-size: 18px; vertical-align: middle; }
        .ecge-sec { border: 1px solid var(--ltek-c-panel-border); border-radius: var(--ltek-r-panel); background: var(--ltek-c-surface); overflow: hidden; }
        .ecge-sec[open] { border-color: var(--ltek-c-accent); }
        .ecge-sec > summary { display: flex; align-items: center; gap: var(--ltek-sp-3); padding: 14px 16px; cursor: pointer; user-select: none;
          list-style: none; font-size: var(--ltek-fs-panel-title); font-weight: var(--ltek-fw-bold); color: var(--ltek-c-text); }
        .ecge-sec > summary::-webkit-details-marker, .ecge-sub > summary::-webkit-details-marker { display: none; }
        .ecge-sec > summary > ha-icon:not(.chev) { color: var(--ltek-c-accent); --mdc-icon-size: var(--ltek-icon-lg); }
        .ecge-sec > summary .chev, .ecge-sub > summary .chev { margin-left: auto; color: #999; --mdc-icon-size: 20px; transition: transform .2s ease; transform: rotate(-90deg); }
        .ecge-sec[open] > summary .chev, .ecge-sub[open] > summary .chev { transform: none; }
        .ecge-body { padding: 0 16px 16px; }
        .ecge-hint { color: var(--ltek-c-muted); font-size: var(--ltek-fs-small); margin: 0 0 var(--ltek-sp-3); }
        .ecge-hint code { font-size: var(--ltek-fs-tiny); }
        .ecge-group { color: var(--accent-color, var(--ltek-c-accent)); font-size: var(--ltek-fs-group); font-weight: var(--ltek-fw-semibold);
          margin-top: var(--ltek-sp-4); padding-top: var(--ltek-sp-3); border-top: 1px solid var(--ltek-c-border-soft); }
        .ecge-group.first { margin-top: 0; padding-top: 0; border-top: none; }
        .ecge-sub { border-top: 1px solid var(--ltek-c-border-soft); border-radius: var(--ltek-r-ctrl); }
        .ecge-sub[open] { border: 1px solid var(--accent-color, var(--ltek-c-accent)); margin: var(--ltek-sp-1) 0; }
        .ecge-sub > summary { display: flex; align-items: center; gap: var(--ltek-sp-2); padding: var(--ltek-sp-3) var(--ltek-sp-2); cursor: pointer;
          list-style: none; color: var(--ltek-c-accent); font-size: var(--ltek-fs-label); font-weight: var(--ltek-fw-semibold);
          text-transform: uppercase; letter-spacing: 0.04em; }
        .ecge-sub-body { padding: 0 var(--ltek-sp-4) var(--ltek-sp-4); }
        .ecge-row { display: flex; align-items: center; gap: var(--ltek-sp-4); padding: var(--ltek-sp-1) 0; flex-wrap: wrap; justify-content: flex-start; }
        .ecge-row label.lbl { color: var(--ltek-c-label); font-size: var(--ltek-fs-body); font-weight: var(--ltek-fw-normal); flex: none; }
        .ecge-row input[type="text"], .ecge-row select { flex: 1 1 auto; min-width: 0; padding: var(--ltek-ctrl-pad);
          background: var(--secondary-background-color, #2a2a2a); border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-ctrl);
          color: var(--ltek-c-text); font-size: var(--ltek-fs-body); }
        .ecge-row input[type="range"] { flex: 1 1 auto; min-width: 100px; accent-color: var(--ltek-c-accent); cursor: pointer; }
        .ecge-val { flex: 0 0 var(--ltek-slider-val-w); text-align: right; font-weight: var(--ltek-fw-bold); font-variant-numeric: tabular-nums;
          white-space: nowrap; color: var(--ltek-c-text); font-size: var(--ltek-fs-body); }
        .ecge-nowrap { flex-wrap: nowrap; }
        .ecge-check { display: flex; align-items: center; gap: var(--ltek-sp-2); padding: var(--ltek-sp-1) 0; color: var(--ltek-c-label);
          font-size: var(--ltek-fs-body); cursor: pointer; }
        .ecge-check input { accent-color: var(--ltek-c-accent); }
        .ecge-check .muted { color: var(--ltek-c-muted); font-size: var(--ltek-fs-small); }
        .ecge-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0 var(--ltek-sp-4); }
        .ecge-color { display: flex; flex: 1 1 auto; gap: var(--ltek-sp-2); flex-wrap: wrap; min-width: 0; }
        .ecge-color select.ecge-cmode { flex: 0 0 auto; min-width: 120px; }
        .ecge-color input[type="color"] { flex: 0 0 auto; width: 44px; height: 30px; padding: 0; border: none; background: none; cursor: pointer; }
        .ecge-reset { border: none; background: none; padding: 0; color: var(--ltek-c-icon); cursor: pointer; }
        .ecge-reset:hover { color: var(--ltek-c-icon-hover); }
        .ecge-reset ha-icon { --mdc-icon-size: var(--ltek-icon-sm); }
        .ecge-list { display: flex; flex-direction: column; gap: var(--ltek-sp-2); }
        .ecge-item { display: flex; align-items: center; gap: var(--ltek-sp-2); padding: var(--ltek-sp-2) var(--ltek-sp-3);
          background: var(--ltek-c-surface-raised); border-radius: var(--ltek-r-card); }
        .ecge-item input[type="text"] { flex: 1 1 0; min-width: 0; padding: var(--ltek-ctrl-pad); background: var(--secondary-background-color, #2a2a2a);
          border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-ctrl); color: var(--ltek-c-text); font-size: var(--ltek-fs-body); }
        .ecge-item > ha-icon { color: var(--ltek-c-accent); --mdc-icon-size: var(--ltek-icon-lg); flex: none; }
        .ecge-del { border: none; background: none; padding: 0; cursor: pointer; color: var(--ltek-c-icon); flex: none; line-height: 0; }
        .ecge-del ha-icon { --mdc-icon-size: var(--ltek-icon-sm); }
        .ecge-del:hover { color: var(--ltek-c-error); }
        .ecge-add { align-self: flex-start; padding: var(--ltek-ctrl-pad); border: 1px dashed var(--ltek-c-accent); border-radius: var(--ltek-r-ctrl);
          background: transparent; color: var(--ltek-c-accent); font-size: var(--ltek-fs-body); font-weight: var(--ltek-fw-semibold); cursor: pointer; }
        .ecge-add:hover { background: var(--ltek-c-accent-fade-soft); }
  .ecge-links { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--divider-color); }
  .ecge-star { display: inline-flex; align-items: center; gap: 6px; font-size: .82rem; font-weight: 600; color: #fff; text-decoration: none; padding: 6px 18px; border-radius: 20px;
    background: linear-gradient(90deg, #f7a92b 0%, #f4731a 100%); box-shadow: 0 2px 8px rgba(244,115,26,.35); }
  .ecge-star:hover { filter: brightness(1.1); }
  .ecge-issue { font-size: .78rem; color: var(--primary-color); text-decoration: none; padding: 4px 10px; border: 1px solid var(--primary-color); border-radius: 14px; }
  .ecge-issue:hover { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
        .ecge-foot { color: var(--ltek-c-muted); font-size: var(--ltek-fs-tiny); text-align: right; }
        .ecge-name { flex: 1 1 auto; min-width: 0; color: var(--ltek-c-text); font-size: var(--ltek-fs-label); font-weight: var(--ltek-fw-normal);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ecge-badge { flex: none; color: var(--ltek-c-muted); font-size: var(--ltek-fs-tiny); font-variant-numeric: tabular-nums;
          border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-ctrl); padding: 0 var(--ltek-sp-1); }
        .ecge-act { border: none; background: none; padding: 0; cursor: pointer; color: var(--ltek-c-icon); flex: none; line-height: 0; }
        .ecge-act:hover { color: var(--ltek-c-icon-hover); }
        .ecge-act.on { color: var(--ltek-c-accent); }
        .ecge-act:disabled { opacity: .3; cursor: default; }
        .ecge-act ha-icon { --mdc-icon-size: var(--ltek-icon-sm); }
        .ecge-item.off .ecge-name, .ecge-item.off > ha-icon { opacity: .45; }
        .ecge-warn { color: var(--ltek-c-warning); }
`;
const EXTRA_EDITOR_CSS = `
        .ecge-cams { display: flex; flex-direction: column; gap: var(--ltek-sp-2); }
        .ecge-cam { background: var(--ltek-c-surface-raised); border-radius: var(--ltek-r-card); border: 1px solid transparent; }
        .ecge-cam.open { border-color: var(--accent-color, var(--ltek-c-accent)); }
        .ecge-cam > .ecge-item { background: none; }
        .ecge-cam-body { padding: 0 var(--ltek-sp-4) var(--ltek-sp-4); }
        .ecge-sub-head { color: var(--ltek-c-accent); font-size: var(--ltek-fs-label); font-weight: var(--ltek-fw-semibold);
          text-transform: uppercase; letter-spacing: 0.04em; }
        .ecge-badge.live { color: var(--ltek-c-accent); border-color: var(--ltek-c-accent); }
        .ecge-badge.start { color: var(--ltek-c-success); border-color: var(--ltek-c-success); }
        .ecge-row input[type="text"].ecge-short { flex: 0 1 140px; }
`;

const ENTITY_LIST_ID = 'ecge-cameras';
const FIT_OPTIONS = [['cover', 'Fill (crop the edges)'], ['contain', 'Whole picture'], ['fill', 'Stretch']];

class EasyCameraGridCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._open = new Set(['cameras']);
    this._openCam = new Set();
  }

  setConfig(config) {
    const next = JSON.parse(JSON.stringify(config || {}));
    const changed = JSON.stringify(next) !== JSON.stringify(this._config);
    this._config = next;
    if (!this._rendered || changed) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._render();
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  /** Write a top-level or nested (landscape.columns) key; '' or the default removes it (byte-stable YAML). */
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

  _val(path) {
    const n = normalizeConfig(this._config);
    const [a, b] = path.split('.');
    return b ? n[a][b] : n[a];
  }

  _isSet(path) {
    const [a, b] = path.split('.');
    return b ? !!this._config[a] && this._config[a][b] !== undefined : this._config[a] !== undefined;
  }

  _cams() { return (this._config.cameras || []).map((x) => (typeof x === 'string' ? { entity: x } : { ...x })); }

  /** Cameras back to the config: a camera with only an entity is written as a plain string. */
  _saveCams(list) {
    this._config.cameras = list.map((c) => {
      const keys = Object.keys(c).filter((k) => c[k] !== '' && c[k] !== undefined && c[k] !== null);
      return keys.length === 1 && keys[0] === 'entity' ? c.entity : Object.fromEntries(keys.map((k) => [k, c[k]]));
    });
    this._emit();
    this._render();
  }

  // ------------------------------------------------------------ building blocks
  _panel(id, icon, title, body) {
    return `<details class="ecge-sec" data-panel="${id}"${this._open.has(id) ? ' open' : ''}>
      <summary><ha-icon icon="${icon}"></ha-icon>${title}<ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></summary>
      <div class="ecge-body">${body}</div></details>`;
  }

  _sub(id, title, body) {
    return `<details class="ecge-sub" data-panel="${id}"${this._open.has(id) ? ' open' : ''}>
      <summary>${title}<ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></summary>
      <div class="ecge-sub-body">${body}</div></details>`;
  }

  _hint(text) { return `<p class="ecge-hint">${text}</p>`; }

  _group(label, first = false) { return `<div class="ecge-group${first ? ' first' : ''}">${label}</div>`; }

  _select(path, label, options, attr = 'data-path') {
    const cur = String(this._val(path));
    return `<div class="ecge-row"><label class="lbl">${label}</label><select ${attr}="${path}">${
      options.map(([v, n]) => `<option value="${esc(v)}"${String(v) === cur ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`;
  }

  _check(path, label, hint = '') {
    return `<label class="ecge-check"><input type="checkbox" data-bool="${path}"${this._val(path) ? ' checked' : ''}>${label}${
      hint ? ` <span class="muted">${hint}</span>` : ''}</label>`;
  }

  /** Label, range, bold readout and ↺ when set: one row that never wraps. */
  _slider(path, label, min, max, step, fmt) {
    const v = Number(this._val(path));
    return `<div class="ecge-row ecge-nowrap"><label class="lbl">${label}</label>
      <input type="range" data-slider="${path}" min="${min}" max="${max}" step="${step}" value="${v}">
      <span class="ecge-val" data-val="${path}">${fmt(v)}</span>
      ${this._isSet(path) ? `<button class="ecge-reset" data-reset="${path}" title="Back to default"><ha-icon icon="mdi:restore"></ha-icon></button>` : ''}</div>`;
  }

  // ------------------------------------------------------------ panels
  _camerasBody() {
    const cams = this._cams();
    const start = this._val('main_camera');
    const rows = cams.map((c, i) => {
      const open = this._openCam.has(i);
      const mode = c.tile_mode || this._val('tile_mode');
      const badges = `${c.entity === start ? '<span class="ecge-badge start">Start</span>' : ''}${
        mode === 'live' ? '<span class="ecge-badge live">Live tile</span>' : ''}`;
      const refreshOwn = c.refresh_seconds !== undefined;
      const body = open ? `<div class="ecge-cam-body">
          <div class="ecge-row"><label class="lbl">Camera</label><input type="text" data-cam="${i}" data-field="entity" list="${ENTITY_LIST_ID}"
            value="${esc(c.entity)}" placeholder="camera.front_door"></div>
          <div class="ecge-row"><label class="lbl">Name</label><input type="text" data-cam="${i}" data-field="name" value="${esc(c.name || '')}"
            placeholder="${esc(camName(this._hass, { entity: c.entity }))}"></div>
          <div class="ecge-row"><label class="lbl">Tile</label><select data-cam="${i}" data-field="tile_mode">${
            [['', `Card default (${this._val('tile_mode') === 'live' ? 'live stream' : 'snapshot'})`], ['snapshot', 'Snapshot'], ['live', 'Live stream']]
              .map(([v, n]) => `<option value="${v}"${(c.tile_mode || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
          ${mode === 'snapshot' ? `<div class="ecge-row ecge-nowrap"><label class="ecge-check"><input type="checkbox" data-cam-refresh="${i}"${refreshOwn ? ' checked' : ''}>Own refresh</label>
            ${refreshOwn ? `<input type="range" data-cam="${i}" data-field="refresh_seconds" min="0.5" max="60" step="0.5" value="${c.refresh_seconds}">
            <span class="ecge-val" data-cam-val="${i}">${fmtSecs(c.refresh_seconds)}</span>`
    : `<span class="muted">${fmtSecs(this._val('refresh_seconds'))} (card default)</span>`}</div>` : ''}
          <div class="ecge-row"><label class="lbl">Fit</label><select data-cam="${i}" data-field="fit">${
            [['', `Card default (${FIT_OPTIONS.find(([v]) => v === this._val('tile_fit'))[1].toLowerCase()})`], ...FIT_OPTIONS]
              .map(([v, n]) => `<option value="${v}"${(c.fit || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>` : '';
      return `<div class="ecge-cam${open ? ' open' : ''}">
        <div class="ecge-item"><ha-icon icon="mdi:cctv"></ha-icon>
          <span class="ecge-name">${esc(camName(this._hass, c))}</span>${badges}
          <button class="ecge-act" data-move="${i}" data-dir="-1" title="Move up"${i === 0 ? ' disabled' : ''}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="ecge-act" data-move="${i}" data-dir="1" title="Move down"${i === cams.length - 1 ? ' disabled' : ''}><ha-icon icon="mdi:arrow-down"></ha-icon></button>
          <button class="ecge-act${open ? ' on' : ''}" data-edit="${i}" title="${open ? 'Done' : 'Edit'}"><ha-icon icon="mdi:pencil"></ha-icon></button>
          <button class="ecge-del" data-del="${i}" title="Remove"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button></div>
        ${body}</div>`;
    }).join('');
    return `${this._hint('The grid shows the cameras in this order. Tap ✏️ to give one camera its own name or tile settings.')}
      <div class="ecge-cams"><button class="ecge-add" data-add="1">+ Camera</button>${rows}</div>
      ${this._group('Start camera')}
      ${this._hint('Shown live in the large pane when the card opens, and where “Go back” returns to.')}
      ${this._select('main_camera', 'Starts live', cams.map((c) => [c.entity, camName(this._hass, c)]))}`;
  }

  _tilesBody() {
    const snap = this._val('tile_mode') === 'snapshot';
    return `${this._hint('Defaults for every tile. A camera can change these for itself in Cameras.')}
      ${this._group('Picture', true)}
      ${this._select('tile_mode', 'Tile shows', [['snapshot', 'Snapshot (JPEG)'], ['live', 'Live stream']])}
      ${snap ? this._slider('refresh_seconds', 'Refresh every', 0.5, 30, 0.5, fmtSecs) : this._hint('Every tile streaming live uses much more of the tablet than snapshots.')}
      ${this._select('tile_fit', 'Fit', FIT_OPTIONS)}
      ${this._group('Label')}
      ${this._check('show_names', 'Show the camera name')}`;
  }

  _mainBody() {
    const reset = Number(this._val('reset_after')) > 0;
    return `${this._hint('The camera you tapped plays here, live.')}
      ${this._group('Picture', true)}
      ${this._select('main_fit', 'Fit', FIT_OPTIONS)}
      ${this._check('muted', 'Muted')}
      ${this._check('show_main_name', 'Show the name and LIVE badge')}
      ${this._group('Go back')}
      <div class="ecge-row ecge-nowrap"><label class="ecge-check"><input type="checkbox" data-reset-on="1"${reset ? ' checked' : ''}>Back to the start camera after</label>
        ${reset ? `<input type="range" data-slider="reset_after" min="10" max="900" step="10" value="${this._val('reset_after')}">
        <span class="ecge-val" data-val="reset_after">${fmtSecs(this._val('reset_after'))}</span>` : ''}</div>
      ${this._hint('Counted from the last touch on the card.')}`;
  }

  _layoutBody() {
    const fill = this._val('height') === 'fill';
    const count = (n) => String(n);
    const one = (o, positions) => this._sub(`layout-${o}`, o === 'landscape' ? 'Landscape' : 'Portrait',
      `${this._select(`${o}.main_position`, 'Large pane', positions)}
      ${this._slider(`${o}.main_size`, 'Large pane size', 20, 90, 1, (n) => `${n}%`)}
      ${this._slider(`${o}.columns`, 'Grid columns', 1, 8, 1, count)}
      ${this._slider(`${o}.rows`, 'Grid rows', 0, 8, 1, (n) => (n ? String(n) : 'Auto'))}`);
    return `${this._hint('Landscape and portrait each have their own layout. With “Follow the screen” the card switches when the tablet turns.')}
      ${this._group('Screen', true)}
      ${this._select('orientation', 'Orientation', [['auto', 'Follow the screen'], ['landscape', 'Always landscape'], ['portrait', 'Always portrait']])}
      <div class="ecge-row"><label class="lbl">Height</label><select data-height-mode="1">
        <option value="fill"${fill ? ' selected' : ''}>Fill the rest of the screen</option>
        <option value="fixed"${fill ? '' : ' selected'}>Fixed height</option></select>
        ${fill ? '' : `<input type="text" class="ecge-short" data-path="height" value="${esc(this._val('height'))}" placeholder="600px or 70vh">`}</div>
      ${this._slider('gap', 'Gap', 0, 24, 1, (n) => `${n}px`)}
      ${this._group('Layouts')}
      ${one('landscape', [['left', 'Left'], ['right', 'Right']])}
      ${one('portrait', [['top', 'Top'], ['bottom', 'Bottom']])}
      ${this._hint('Rows “Auto” fits every tile; a set number of rows scrolls the grid when there are more tiles.')}`;
  }

  _render() {
    const ae = document.activeElement && this.contains(document.activeElement) ? document.activeElement : null;
    const focusSel = ae ? (ae.dataset.cam !== undefined ? `[data-cam="${ae.dataset.cam}"][data-field="${ae.dataset.field}"]`
      : ae.dataset.path ? `[data-path="${ae.dataset.path}"]` : null) : null;
    const camIds = Object.keys(this._hass?.states || {}).filter((id) => id.startsWith('camera.')).sort();
    this.innerHTML = `<style>${EDITOR_CSS}${EXTRA_EDITOR_CSS}</style>
      <div class="ecge">
        <datalist id="${ENTITY_LIST_ID}">${camIds.map((id) => `<option value="${esc(id)}"></option>`).join('')}</datalist>
        ${this._panel('cameras', 'mdi:cctv', 'Cameras', this._camerasBody())}
        ${this._panel('tiles', 'mdi:view-grid-outline', 'Grid tiles', this._tilesBody())}
        ${this._panel('main', 'mdi:video-outline', 'Large pane', this._mainBody())}
        ${this._panel('layout', 'mdi:page-layout-sidebar-left', 'Layout', this._layoutBody())}
        <div class="ecge-links">
          <a class="ecge-star" href="https://github.com/Ltek/easy-camera-grid-card" target="_blank" rel="noopener">⭐ Star on GitHub</a>
          <a class="ecge-issue" href="https://github.com/Ltek/easy-camera-grid-card/issues" target="_blank" rel="noopener">🐛 Report an issue</a>
        </div>
        <div class="ecge-foot">Easy Camera Grid Card (Ltek) ${BUILD_NUMBER}</div>
      </div>`;
    this._rendered = true;
    this._wire();
    if (focusSel) { const el = this.querySelector(focusSel); if (el) el.focus(); }
  }

  _wire() {
    const all = (sel, fn) => this.querySelectorAll(sel).forEach(fn);
    all('details.ecge-sec, details.ecge-sub', (d) => d.addEventListener('toggle', () => {
      if (d.open) this._open.add(d.dataset.panel); else this._open.delete(d.dataset.panel);
    }));
    // plain fields: select / text
    all('select[data-path], input[type="text"][data-path]', (el) => el.addEventListener('change', () => {
      this._set(el.dataset.path, el.value.trim());
      if (el.tagName === 'SELECT') this._render();
    }));
    all('[data-bool]', (el) => el.addEventListener('change', () => this._set(el.dataset.bool, el.checked)));
    // sliders: readout follows while dragging, the value is written on release
    all('input[data-slider]', (el) => {
      const path = el.dataset.slider;
      const out = this.querySelector(`[data-val="${path}"]`);
      const fmt = path === 'refresh_seconds' || path === 'reset_after' ? fmtSecs
        : path.endsWith('main_size') ? (n) => `${n}%` : path === 'gap' ? (n) => `${n}px`
          : path.endsWith('rows') ? (n) => (Number(n) ? String(n) : 'Auto') : String;
      el.addEventListener('input', () => { if (out) out.textContent = fmt(Number(el.value)); });
      el.addEventListener('change', () => { this._set(path, Number(el.value)); this._render(); });
    });
    all('[data-reset]', (b) => b.addEventListener('click', () => { this._set(b.dataset.reset, ''); this._render(); }));
    all('[data-reset-on]', (el) => el.addEventListener('change', () => { this._set('reset_after', el.checked ? 120 : ''); this._render(); }));
    all('[data-height-mode]', (el) => el.addEventListener('change', () => {
      this._set('height', el.value === 'fill' ? '' : '600px'); this._render();
    }));
    // camera list
    all('[data-add]', (b) => b.addEventListener('click', () => {
      const cams = this._cams(), used = new Set(cams.map((c) => c.entity));
      const next = Object.keys(this._hass?.states || {}).filter((id) => id.startsWith('camera.') && !used.has(id)).sort()[0] || 'camera.';
      cams.push({ entity: next });
      this._openCam.add(cams.length - 1);
      this._saveCams(cams);
    }));
    all('[data-edit]', (b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.edit);
      if (this._openCam.has(i)) this._openCam.delete(i); else this._openCam.add(i);
      this._render();
    }));
    all('[data-move]', (b) => b.addEventListener('click', () => {
      const cams = this._cams(), i = Number(b.dataset.move), j = i + Number(b.dataset.dir);
      if (j < 0 || j >= cams.length) return;
      [cams[i], cams[j]] = [cams[j], cams[i]];
      const oi = this._openCam.has(i), oj = this._openCam.has(j);
      this._openCam.delete(i); this._openCam.delete(j);
      if (oi) this._openCam.add(j);
      if (oj) this._openCam.add(i);
      this._saveCams(cams);
    }));
    all('[data-del]', (b) => b.addEventListener('click', () => {
      const cams = this._cams(), i = Number(b.dataset.del);
      cams.splice(i, 1);
      this._openCam = new Set([...this._openCam].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)));
      this._saveCams(cams);
    }));
    all('[data-cam]', (el) => {
      const i = Number(el.dataset.cam), field = el.dataset.field;
      if (el.type === 'range') {
        const out = this.querySelector(`[data-cam-val="${i}"]`);
        el.addEventListener('input', () => { if (out) out.textContent = fmtSecs(Number(el.value)); });
      }
      el.addEventListener('change', () => {
        const cams = this._cams(), c = cams[i];
        let v = el.value.trim();
        if (field === 'refresh_seconds') v = Number(v);
        if (v === '') delete c[field]; else c[field] = v;
        if (field === 'entity' && !v) return;
        this._saveCams(cams);
      });
    });
    all('[data-cam-refresh]', (el) => el.addEventListener('change', () => {
      const cams = this._cams(), c = cams[Number(el.dataset.camRefresh)];
      if (el.checked) c.refresh_seconds = this._val('refresh_seconds'); else delete c.refresh_seconds;
      this._saveCams(cams);
    }));
  }
}

function fmtSecs(n) {
  n = Number(n);
  if (n >= 60 && n % 60 === 0) return `${n / 60} min`;
  if (n >= 60) return `${Math.floor(n / 60)}m ${n % 60}s`;
  return `${n} s`;
}

// Test hooks (pure helpers; no effect in the browser)
EasyCameraGridCard._test = {
  BUILD_NUMBER, VERSION, DEFAULTS, CARD_CSS, normalizeConfig, tileSettings, gridCameras, layoutFor,
  resolveOrientation, snapshotUrl, camName, ensureStreamElement, tileMessage, fmtSecs, VIEW,
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
