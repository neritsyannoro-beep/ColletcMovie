/**
 * Хранилище коллекции.
 *
 * Данные лежат в двух местах сразу:
 *   1. localStorage — основное, синхронное, читается мгновенно при старте;
 *   2. IndexedDB    — зеркало, переживает случайную чистку localStorage.
 * Плюс три последних снимка в localStorage на случай, если текущая запись
 * окажется битой. При старте берётся то хранилище, где записей больше.
 */

const KEY        = 'collectmovie:v1';
const KEY_SNAPS  = 'collectmovie:snapshots';
const KEY_PREFS  = 'collectmovie:prefs';
const DB_NAME    = 'collectmovie';
const DB_STORE   = 'kv';
const MAX_SNAPS  = 3;

/* ------------------------------- IndexedDB ------------------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no idb'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbSet(value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, KEY);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
  } catch { /* зеркало не критично — молча пропускаем */ }
}

async function idbGet() {
  try {
    const db = await openDB();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const rq = tx.objectStore(DB_STORE).get(KEY);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror   = () => reject(rq.error);
    });
    db.close();
    return value || null;
  } catch { return null; }
}

/* ------------------------------ localStorage ----------------------------- */

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch { return false; }
}

function parse(raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.items)) return data;
  } catch { /* битый JSON */ }
  return null;
}

/* --------------------------------- Состояние ------------------------------ */

let state = { version: 1, items: [], updatedAt: null };
let prefs = { tmdbKey: '', lang: 'ru-RU', lastBackupAt: null };

/** Загружает коллекцию. Выбирает самый полный из доступных источников. */
export async function load() {
  const candidates = [];

  const main = parse(lsGet(KEY));
  if (main) candidates.push(main);

  const mirror = await idbGet();
  if (mirror && Array.isArray(mirror.items)) candidates.push(mirror);

  // Снимки — последняя линия обороны, если и основное, и зеркало пусты либо биты.
  if (!candidates.length) {
    try {
      const list = JSON.parse(lsGet(KEY_SNAPS) || '[]');
      for (const snap of list) if (snap && Array.isArray(snap.items)) candidates.push(snap);
    } catch { /* снимков нет или они битые */ }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.items.length - a.items.length);
    state = candidates[0];
    state.items = state.items.filter(Boolean).map(normalize);

    // Основное хранилище потерялось, а зеркало уцелело — сразу чиним основное.
    if (!main || main.items.length < state.items.length) {
      lsSet(KEY, JSON.stringify(state));
    }
  }

  try { prefs = { ...prefs, ...JSON.parse(lsGet(KEY_PREFS) || '{}') }; } catch { /* дефолты */ }

  // Просим браузер не выбрасывать наши данные при нехватке места.
  try { navigator.storage?.persist?.(); } catch { /* не поддерживается */ }

  return state.items;
}

/** Приводит запись к актуальной схеме (на случай старых бэкапов). */
function normalize(item) {
  return {
    id:            String(item.id),
    type:          ['movie', 'series', 'anime'].includes(item.type) ? item.type : 'movie',
    title:         item.title || 'Без названия',
    originalTitle: item.originalTitle || '',
    year:          item.year ?? null,
    poster:        item.poster || '',
    overview:      item.overview || '',
    genres:        Array.isArray(item.genres) ? item.genres : [],
    source:        item.source || 'manual',
    sourceId:      item.sourceId ?? null,
    status:        ['watched', 'watching', 'planned', 'dropped'].includes(item.status) ? item.status : 'watched',
    rating:        Number.isFinite(item.rating) && item.rating >= 1 && item.rating <= 10 ? item.rating : null,
    note:          item.note || '',
    // Оценка самой базы (TMDB или MyAnimeList) — не путать с твоей.
    voteAverage:   Number.isFinite(item.voteAverage) ? item.voteAverage : null,
    voteCount:     Number.isFinite(item.voteCount) ? item.voteCount : 0,
    episodes:      Number.isFinite(item.episodes) ? item.episodes : null,
    addedAt:       item.addedAt || new Date().toISOString(),
    updatedAt:     item.updatedAt || item.addedAt || new Date().toISOString(),
  };
}

let snapTimer = null;
let pendingSnap = null;

/** Дописывает отложенный снимок (зеркало пишется сразу и здесь не участвует). */
function flushSnapshot() {
  if (!pendingSnap) return;
  const raw = pendingSnap;
  pendingSnap = null;
  clearTimeout(snapTimer);
  snapTimer = null;
  snapshot(raw);
}

// Снимок можно и отложить, но при уходе со страницы дописываем его гарантированно.
window.addEventListener('pagehide', flushSnapshot);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSnapshot();
});

/** Сохраняет состояние: localStorage и зеркало — сразу, снимок — с задержкой. */
function persist() {
  state.updatedAt = new Date().toISOString();
  const raw = JSON.stringify(state);

  if (!lsSet(KEY, raw)) {
    // Кончилось место — чистим снимки и пробуем ещё раз.
    try { localStorage.removeItem(KEY_SNAPS); } catch { /* ignore */ }
    if (!lsSet(KEY, raw)) {
      window.dispatchEvent(new CustomEvent('store:error', {
        detail: 'Не удалось сохранить: в браузере кончилось место. Сделай экспорт и почисти данные сайтов.',
      }));
      return;
    }
  }

  // Зеркало пишем сразу, без задержки: правок у человека единицы, зато копия
  // гарантированно на диске, даже если вкладку закроют в следующую секунду.
  idbSet(JSON.parse(raw));

  // Снимки — единственное, что можно отложить: они нужны только как крайний
  // запасной вариант, а писать их на каждое нажатие оценки незачем.
  pendingSnap = raw;
  if (!snapTimer) {
    snapTimer = setTimeout(() => { snapTimer = null; flushSnapshot(); }, 1500);
  }
}

/** Держит до трёх последних снимков коллекции. */
function snapshot(raw) {
  try {
    const list = JSON.parse(lsGet(KEY_SNAPS) || '[]');
    list.unshift(JSON.parse(raw));
    lsSet(KEY_SNAPS, JSON.stringify(list.slice(0, MAX_SNAPS)));
  } catch { /* снимки не критичны */ }
}

/* ---------------------------------- API ---------------------------------- */

export function all() { return state.items; }

export function get(id) { return state.items.find((i) => i.id === id) || null; }

export function has(id) { return state.items.some((i) => i.id === id); }

export function upsert(item) {
  const now = new Date().toISOString();
  const idx = state.items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    state.items[idx] = normalize({ ...state.items[idx], ...item, updatedAt: now });
  } else {
    state.items.unshift(normalize({ ...item, addedAt: now, updatedAt: now }));
  }
  persist();
  return get(item.id);
}

export function remove(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx >= 0) { state.items.splice(idx, 1); persist(); return true; }
  return false;
}

export function wipe() {
  state.items = [];
  persist();
  pendingSnap = null;
  clearTimeout(snapTimer);
  snapTimer = null;
  try { localStorage.removeItem(KEY_SNAPS); } catch { /* ignore */ }
}

/* ------------------------------- Настройки -------------------------------- */

export function getPrefs() { return { ...prefs }; }

export function setPrefs(patch) {
  prefs = { ...prefs, ...patch };
  lsSet(KEY_PREFS, JSON.stringify(prefs));
  return getPrefs();
}

/* --------------------------- Экспорт / импорт ----------------------------- */

export function exportJSON() {
  return JSON.stringify({
    app: 'CollectMovie',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: state.items.length,
    items: state.items,
  }, null, 2);
}

/**
 * Импорт бэкапа.
 * @param {string} raw   содержимое файла
 * @param {'merge'|'replace'} mode
 * @returns {{added:number, updated:number, total:number}}
 */
export function importJSON(raw, mode = 'merge') {
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('Файл не читается — это не JSON.'); }

  const incoming = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(incoming)) throw new Error('В файле нет списка записей.');

  if (mode === 'replace') state.items = [];

  let added = 0, updated = 0;
  for (const rawItem of incoming) {
    if (!rawItem || !rawItem.id) continue;
    const item = normalize(rawItem);
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      // При слиянии выигрывает более свежая запись.
      if (new Date(item.updatedAt) > new Date(state.items[idx].updatedAt)) {
        state.items[idx] = item;
        updated++;
      }
    } else {
      state.items.push(item);
      added++;
    }
  }

  state.items.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  persist();
  return { added, updated, total: state.items.length };
}

/** Оценка занятого места — для экрана настроек. */
export async function usage() {
  const bytes = new Blob([JSON.stringify(state)]).size;
  let quota = null;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) quota = est.quota;
  } catch { /* не поддерживается */ }
  let persisted = false;
  try { persisted = await navigator.storage?.persisted?.() ?? false; } catch { /* ignore */ }
  return { bytes, quota, persisted, count: state.items.length };
}
