/**
 * Источники поиска.
 *
 * Аниме   — Jikan (MyAnimeList), без ключа.
 * Сериалы — TVmaze, без ключа. С ключом TMDB — TMDB (лучше и по-русски).
 * Фильмы  — iTunes Search (без ключа, русский стор даёт русские названия).
 *           С ключом TMDB — TMDB.
 *
 * Все запросы идут прямо из браузера, сервер приложению не нужен.
 */

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';

/* -------------------------------- утилиты -------------------------------- */

const stripHTML = (html = '') =>
  html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();

const yearOf = (date) => {
  const y = parseInt(String(date || '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 1870 ? y : null;
};

async function fetchJSON(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSONP — единственный способ дёрнуть iTunes Search из браузера:
 * CORS-заголовков он не отдаёт, зато поддерживает ?callback=.
 */
let jsonpSeq = 0;
function fetchJSONP(url, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const cb = `__cm_jsonp_${Date.now()}_${jsonpSeq++}`;
    const script = document.createElement('script');
    const done = (fn, arg) => {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeout);

    window[cb] = (data) => done(resolve, data);
    script.onerror = () => done(reject, new Error('network'));
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${cb}`;
    document.head.appendChild(script);
  });
}

/* ------------------------------ карта жанров ------------------------------ */

const genreCache = new Map();   // `${kind}:${lang}` -> Map(id -> name)

async function tmdbGenres(kind, key, lang) {
  const cacheKey = `${kind}:${lang}`;
  if (genreCache.has(cacheKey)) return genreCache.get(cacheKey);
  try {
    const data = await fetchJSON(
      `${TMDB_API}/genre/${kind}/list?api_key=${encodeURIComponent(key)}&language=${lang}`);
    const map = new Map((data.genres || []).map((g) => [g.id, g.name]));
    genreCache.set(cacheKey, map);
    return map;
  } catch {
    const empty = new Map();
    genreCache.set(cacheKey, empty);
    return empty;
  }
}

/* ---------------------------------- TMDB ---------------------------------- */

async function searchTMDB(query, kind, { key, lang }) {
  const url = `${TMDB_API}/search/${kind}`
    + `?api_key=${encodeURIComponent(key)}`
    + `&query=${encodeURIComponent(query)}`
    + `&language=${lang}&include_adult=false&page=1`;

  let data;
  try {
    data = await fetchJSON(url);
  } catch (err) {
    if (err.status === 401) throw new Error('TMDB отклонил ключ — проверь его в настройках.');
    throw err;
  }

  const genres = await tmdbGenres(kind === 'movie' ? 'movie' : 'tv', key, lang);
  const type = kind === 'movie' ? 'movie' : 'series';

  return (data.results || []).map((r) => ({
    id:            `tmdb-${kind}-${r.id}`,
    type,
    title:         r.title || r.name || 'Без названия',
    originalTitle: (r.original_title || r.original_name || '') !== (r.title || r.name || '')
                     ? (r.original_title || r.original_name || '') : '',
    year:          yearOf(r.release_date || r.first_air_date),
    poster:        r.poster_path ? TMDB_IMG + r.poster_path : '',
    overview:      r.overview || '',
    genres:        (r.genre_ids || []).map((id) => genres.get(id)).filter(Boolean),
    source:        'tmdb',
    sourceId:      r.id,
    popularity:    r.popularity || 0,
  }));
}

/* ---------------------------------- Jikan --------------------------------- */

async function searchAnime(query) {
  const url = `https://api.jikan.moe/v4/anime`
    + `?q=${encodeURIComponent(query)}&limit=20&sfw=true`;

  const data = await fetchJSON(url);

  return (data.data || []).map((a) => {
    const title = a.title_english || a.title || a.title_japanese || 'Без названия';
    const orig  = a.title && a.title !== title ? a.title : '';
    return {
      id:            `jikan-${a.mal_id}`,
      type:          'anime',
      title,
      originalTitle: orig,
      year:          a.year || yearOf(a.aired?.from),
      poster:        a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
      overview:      a.synopsis || '',
      genres:        (a.genres || []).map((g) => g.name),
      source:        'jikan',
      sourceId:      a.mal_id,
      episodes:      a.episodes || null,
      popularity:    a.members || 0,
    };
  });
}

/* --------------------------------- TVmaze --------------------------------- */

async function searchTVmaze(query) {
  const data = await fetchJSON(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);

  return (data || []).map(({ show: s }) => ({
    id:            `tvmaze-${s.id}`,
    type:          'series',
    title:         s.name || 'Без названия',
    originalTitle: '',
    year:          yearOf(s.premiered),
    poster:        s.image?.original || s.image?.medium || '',
    overview:      stripHTML(s.summary || ''),
    genres:        s.genres || [],
    source:        'tvmaze',
    sourceId:      s.id,
    popularity:    s.weight || 0,
  }));
}

/* --------------------------------- iTunes --------------------------------- */

async function searchITunes(query, lang) {
  const country = lang === 'ru-RU' ? 'RU' : 'US';
  const url = 'https://itunes.apple.com/search'
    + `?term=${encodeURIComponent(query)}&media=movie&entity=movie`
    + `&limit=20&country=${country}`;

  const data = await fetchJSONP(url);

  return (data.results || []).map((r) => ({
    id:            `itunes-${r.trackId}`,
    type:          'movie',
    title:         r.trackName || 'Без названия',
    originalTitle: '',
    year:          yearOf(r.releaseDate),
    // artworkUrl100 отдаёт кроп 100×100; Apple принимает любой размер в имени файла.
    poster:        (r.artworkUrl100 || '').replace(/\/\d+x\d+bb\./, '/600x600bb.'),
    overview:      r.longDescription || r.shortDescription || '',
    genres:        r.primaryGenreName ? [r.primaryGenreName] : [],
    source:        'itunes',
    sourceId:      r.trackId,
    popularity:    0,
  }));
}

/* --------------------------------- фасад ---------------------------------- */

/**
 * Ищет по выбранному типу.
 * @param {string} query
 * @param {'all'|'movie'|'series'|'anime'} type
 * @param {{tmdbKey?:string, lang?:string}} prefs
 * @returns {Promise<{results:Array, warnings:string[]}>}
 */
export async function search(query, type, prefs = {}) {
  const q = query.trim();
  if (q.length < 2) return { results: [], warnings: [] };

  const key  = (prefs.tmdbKey || '').trim();
  const lang = prefs.lang || 'ru-RU';
  const jobs = [];

  const wantMovie  = type === 'all' || type === 'movie';
  const wantSeries = type === 'all' || type === 'series';
  const wantAnime  = type === 'all' || type === 'anime';

  if (wantMovie) {
    jobs.push(key ? searchTMDB(q, 'movie', { key, lang }) : searchITunes(q, lang));
  }
  if (wantSeries) {
    jobs.push(key ? searchTMDB(q, 'tv', { key, lang }) : searchTVmaze(q));
  }
  if (wantAnime) {
    jobs.push(searchAnime(q));
  }

  const settled = await Promise.allSettled(jobs);

  const results = [];
  const warnings = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') results.push(...r.value);
    else warnings.push(r.reason?.message || 'источник не ответил');
  }

  return { results: rank(results, q), warnings: [...new Set(warnings)] };
}

/** Сортирует выдачу: точное совпадение названия выше, потом популярность. */
function rank(items, query) {
  const q = query.toLowerCase().trim();

  const scoreOf = (item) => {
    const t = (item.title || '').toLowerCase();
    const o = (item.originalTitle || '').toLowerCase();
    let s = 0;
    if (t === q || o === q) s += 1000;
    else if (t.startsWith(q) || o.startsWith(q)) s += 600;
    else if (t.includes(q) || o.includes(q)) s += 300;
    if (item.year) s += 10;
    if (item.poster) s += 25;
    return s;
  };

  // Популярность у источников в разных шкалах — нормализуем внутри источника.
  const maxPop = new Map();
  for (const i of items) {
    maxPop.set(i.source, Math.max(maxPop.get(i.source) || 0, i.popularity || 0));
  }

  return items
    .map((i) => {
      const cap = maxPop.get(i.source) || 1;
      return { item: i, s: scoreOf(i) + ((i.popularity || 0) / cap) * 80 };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.item);
}
