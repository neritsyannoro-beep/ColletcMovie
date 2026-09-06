/**
 * Рекомендации на основе коллекции.
 *
 * Берём из библиотеки несколько самых высоко оценённых просмотренных тайтлов
 * категории, спрашиваем у баз «что похоже на это», и складываем ответы:
 * чем выше твоя оценка источника и чем чаще тайтл советуют разные источники,
 * тем он выше в списке. Уже добавленное отсеиваем.
 */

import * as store from './store.js';
import { tmdbRecommendations, jikanRecommendations } from './providers.js';

const CACHE_KEY  = 'collectmovie:recs';
const CACHE_TTL  = 6 * 60 * 60 * 1000;   // 6 часов
const MAX_SEEDS  = 8;    // столько тайтлов опрашиваем за раз
const SEED_POOL  = 30;   // из скольких лучших выбираем эту восьмёрку
const MAX_OUTPUT = 40;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ вспомогательное --------------------------- */

const normTitle = (title = '') =>
  title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Тасовка, зависящая от круга: один круг — один и тот же результат. */
function shuffleFor(list, round) {
  const arr = [...list];
  let state = (round + 1) * 9301 + 49297;
  const next = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Тайтлы, на которых строим подборку.
 *
 * Раньше это была просто восьмёрка самых любимых — и подборка не менялась
 * никогда: те же источники дают тот же ответ. Теперь берём из тридцати лучших
 * случайную восьмёрку, своя на каждый круг обновления, поэтому кнопка
 * «обновить» показывает новое, оставаясь в рамках того, что тебе нравится.
 */
function pickSeeds(type, round = 0) {
  const pool = store.all()
    .filter((i) => i.type === type && (i.status === 'watched' || i.status === 'watching'))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)
                 || new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, SEED_POOL);

  if (pool.length <= MAX_SEEDS) return pool;
  return shuffleFor(pool, round).slice(0, MAX_SEEDS);
}

/** Всё, что уже в коллекции, — и по id, и по названию (id у баз разные). */
function excluded() {
  const ids = new Set();
  const titles = new Set();
  for (const item of store.all()) {
    ids.add(item.id);
    titles.add(normTitle(item.title));
    if (item.originalTitle) titles.add(normTitle(item.originalTitle));
  }
  return { ids, titles };
}

/** Подпись набора источников: меняется коллекция — устаревает кэш. */
function signature(seeds) {
  return seeds.map((s) => `${s.id}:${s.rating ?? ''}`).join(',');
}

/* --------------------------------- кэш ----------------------------------- */

function readCache(type, sig) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    const hit = all[type];
    if (!hit || hit.sig !== sig) return null;
    if (Date.now() - hit.at > CACHE_TTL) return null;
    return hit.items;
  } catch { return null; }
}

function writeCache(type, sig, items) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[type] = { sig, at: Date.now(), items };
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* кэш не критичен */ }
}

export function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

/* ------------------------------ сбор советов ------------------------------ */

/**
 * Запрашивает «похожее» для одного тайтла коллекции.
 *
 * У TMDB два разных списка: recommendations (что смотрят вместе с этим) и
 * similar (что похоже по жанрам и темам). Берём оба и по две страницы —
 * иначе при большой коллекции почти всё отсеивается как уже просмотренное.
 */
async function similarTo(seed, { key, lang }) {
  if (seed.source === 'tmdb' && seed.sourceId) {
    // id вида tmdb-movie-27205 / tmdb-tv-1396 — вид нужен для эндпоинта
    const kind = seed.id.startsWith('tmdb-movie') ? 'movie' : 'tv';
    if (!key) return [];

    const requests = [
      tmdbRecommendations(kind, seed.sourceId, { key, lang, page: 1 }),
      tmdbRecommendations(kind, seed.sourceId, { key, lang, page: 2 }),
      tmdbRecommendations(kind, seed.sourceId, { key, lang, page: 1, endpoint: 'similar' }),
    ];
    const settled = await Promise.allSettled(requests);
    const merged = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!merged.length && settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
    return merged;
  }
  if ((seed.source === 'jikan' || seed.source === 'anilist') && seed.type === 'anime') {
    // У AniList свои id, а рекомендации мы умеем брать только по MAL —
    // поэтому для AniList-записей пропускаем.
    if (seed.source !== 'jikan') return [];
    return jikanRecommendations(seed.sourceId);
  }
  return [];   // iTunes, TVmaze и ручные записи «похожего» не отдают
}

/**
 * Собирает подборку для категории.
 * @param {'movie'|'series'|'anime'} type
 * @param {{tmdbKey?:string, lang?:string}} prefs
 * @param {{force?:boolean, round?:number}} options
 * @returns {Promise<{items:Array, seeds:Array, status:string}>}
 *   status: 'ok' | 'no-seeds' | 'need-key' | 'failed'
 */
export async function recommend(type, prefs = {}, options = {}) {
  const key  = (prefs.tmdbKey || '').trim();
  const lang = prefs.lang || 'ru-RU';

  const round = options.round || 0;
  const seeds = pickSeeds(type, round);
  if (!seeds.length) return { items: [], seeds, status: 'no-seeds' };

  // Фильмы и сериалы умеет советовать только TMDB; аниме вытянет и Jikan.
  const usable = seeds.filter((s) =>
    (s.source === 'tmdb' && key) || (s.source === 'jikan' && s.type === 'anime'));
  if (!usable.length) {
    return { items: [], seeds, status: key ? 'no-seeds' : 'need-key' };
  }

  const sig = `${round}|${signature(usable)}`;
  if (!options.force) {
    const cached = readCache(type, sig);
    if (cached) return { items: cached, seeds: usable, status: 'ok' };
  }

  const { ids, titles } = excluded();
  const pool = new Map();   // ключ -> { item, score, from:Set }
  let failures = 0;

  for (const seed of usable) {
    let similar;
    try {
      similar = await similarTo(seed, { key, lang });
    } catch {
      failures++;
      continue;
    }

    // Оценка источника задаёт вес: совет по любимому фильму весомее.
    const weight = (seed.rating ?? 7) / 10;

    similar.forEach((candidate, index) => {
      if (candidate.type !== type) return;
      if (ids.has(candidate.id)) return;
      const norm = normTitle(candidate.title);
      if (titles.has(norm)) return;

      const bucket = pool.get(norm) || { item: candidate, score: 0, from: new Set() };
      // Чем ниже в чужом списке, тем меньше вклад.
      bucket.score += weight / (1 + index * 0.15);
      bucket.from.add(seed.title);
      // Между дублями выбираем карточку побогаче — с постером и описанием.
      if (!bucket.item.poster && candidate.poster) bucket.item = candidate;
      pool.set(norm, bucket);
    });

    // Jikan не любит частые запросы — притормаживаем между ними.
    if (seed.source === 'jikan') await delay(400);
  }

  if (!pool.size) {
    return { items: [], seeds: usable, status: failures ? 'failed' : 'no-seeds' };
  }

  const items = [...pool.values()]
    // Совпадение у нескольких любимых тайтлов — сигнал сильнее одиночного.
    .sort((a, b) => (b.score + b.from.size * 0.35) - (a.score + a.from.size * 0.35))
    .slice(0, MAX_OUTPUT)
    .map(({ item, from }) => ({ ...item, because: [...from].slice(0, 2) }));

  writeCache(type, sig, items);
  return { items, seeds: usable, status: 'ok' };
}
