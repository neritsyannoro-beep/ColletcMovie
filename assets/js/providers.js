/**
 * Источники поиска. Все запросы идут прямо из браузера, сервер не нужен.
 *
 * Без ключа:
 *   аниме   — Jikan (MyAnimeList), при сбое — AniList;
 *   сериалы — TVmaze;
 *   фильмы  — iTunes Search.
 *   Все три ищут по оригинальным названиям, поэтому русские запросы
 *   находятся плохо — это ограничение самих баз, а не приложения.
 *
 * С ключом TMDB:
 *   фильмы и сериалы ищутся в TMDB с русскими названиями, аниме оттуда же
 *   распознаётся по языку и жанру, а Jikan/AniList добавляют то, чего в
 *   TMDB нет.
 */

const TMDB_API = 'https://api.themoviedb.org/3';

/**
 * Когда TMDB недоступна (а из некоторых сетей она недоступна подолгу), ждать
 * её таймаут на каждом запросе — это лишние секунды в пустоту. Запоминаем
 * отказ на минуту и всё это время опрашиваем запасные базы сразу, не дожидаясь
 * её. Любой успешный ответ размыкатель снимает.
 */
const TMDB_COOLDOWN = 60 * 1000;

/** Ни один источник не вправе держать выдачу дольше этого. */
const JOB_DEADLINE = 11000;
let tmdbDownUntil = 0;

const tmdbLooksDown = () => Date.now() < tmdbDownUntil;
const markTmdbDown  = () => { tmdbDownUntil = Date.now() + TMDB_COOLDOWN; };
const markTmdbUp    = () => { tmdbDownUntil = 0; };
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

/**
 * @param {{timeout?:number, signal?:AbortSignal, init?:RequestInit}} options
 *   signal приходит снаружи: когда человек печатает дальше, прошлый запрос
 *   надо оборвать, иначе браузер упирается в лимит соединений и новые
 *   запросы ждут в очереди за уже ненужными.
 */
async function fetchJSON(url, { timeout = 8000, signal, init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay, { once: true });

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Повторяет запрос при разрыве связи или ошибке сервера. Именно на этом
 * спотыкался Jikan: он периодически отвечает 5xx, и без повтора аниме
 * просто пропадало из выдачи.
 */
async function withRetry(run, tries = 2) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await run();
    } catch (err) {
      last = err;
      const retriable = !err.status || err.status >= 500 || err.status === 429;
      if (!retriable || attempt === tries - 1) break;
      await delay(500);
    }
  }
  throw last;
}

/**
 * JSONP — единственный способ дёрнуть iTunes Search из браузера:
 * CORS-заголовков он не отдаёт, зато поддерживает ?callback=.
 */
let jsonpSeq = 0;
function fetchJSONP(url, { timeout = 8000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const cb = `__cm_jsonp_${Date.now()}_${jsonpSeq++}`;
    const script = document.createElement('script');
    const done = (fn, arg) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      delete window[cb];
      script.remove();
      fn(arg);
    };
    const onAbort = () => done(reject, new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
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

/** Приводит запись TMDB к внутреннему виду. Общий для поиска и рекомендаций. */
function mapTMDB(r, kind, genres) {
  const base = kind === 'movie' ? 'movie' : 'series';
  return {
    id:            `tmdb-${kind}-${r.id}`,
    // Японская анимация — это аниме, даже если TMDB считает её обычным
    // сериалом или мультфильмом (16 — жанр «Анимация»).
    type:          r.original_language === 'ja' && (r.genre_ids || []).includes(16)
                     ? 'anime' : base,
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
    voteAverage:   r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    voteCount:     r.vote_count || 0,
  };
}

async function searchTMDB(query, kind, { key, lang, signal }) {
  const url = `${TMDB_API}/search/${kind}`
    + `?api_key=${encodeURIComponent(key)}`
    + `&query=${encodeURIComponent(query)}`
    + `&language=${lang}&include_adult=false&page=1`;

  // Список жанров — отдельный запрос, и ждать его после поиска незачем.
  const [data, genres] = await Promise.all([
    fetchJSON(url, { signal }).catch((err) => {
      if (err.status === 401) throw new Error('TMDB отклонил ключ — проверь его в настройках.');
      if (!signal?.aborted) markTmdbDown();
      throw err;
    }),
    tmdbGenres(kind === 'movie' ? 'movie' : 'tv', key, lang),
  ]);

  markTmdbUp();
  return (data.results || []).map((r) => mapTMDB(r, kind, genres));
}

/**
 * Подробности одного тайтла. Нужны для карточек, добавленных раньше, —
 * в них оценки TMDB ещё не было, а перезапрашивать всю выдачу ради неё глупо.
 */
export async function tmdbDetails(kind, id, { key, lang }) {
  const data = await withRetry(() => fetchJSON(
    `${TMDB_API}/${kind}/${encodeURIComponent(id)}`
    + `?api_key=${encodeURIComponent(key)}&language=${lang}`));

  return {
    voteAverage: data.vote_average ? Math.round(data.vote_average * 10) / 10 : null,
    voteCount:   data.vote_count || 0,
    runtime:     data.runtime || data.episode_run_time?.[0] || null,
    seasons:     data.number_of_seasons || null,
    episodes:    data.number_of_episodes || null,
    genres:      (data.genres || []).map((g) => g.name),
    overview:    data.overview || '',
  };
}

/** Оценка MyAnimeList для конкретного аниме. */
export async function jikanDetails(id) {
  const { data } = await withRetry(() =>
    fetchJSON(`https://api.jikan.moe/v4/anime/${encodeURIComponent(id)}`));
  return {
    voteAverage: data?.score || null,
    voteCount:   data?.scored_by || 0,
    episodes:    data?.episodes || null,
    genres:      (data?.genres || []).map((g) => g.name),
    overview:    data?.synopsis || '',
  };
}

/* ----------------------------- рекомендации ------------------------------ */

/**
 * «Похожее» от TMDB для одного тайтла.
 * @param {'movie'|'tv'} kind
 */
export async function tmdbRecommendations(kind, id, { key, lang, page = 1, endpoint = 'recommendations' }) {
  const url = `${TMDB_API}/${kind}/${encodeURIComponent(id)}/${endpoint}`
    + `?api_key=${encodeURIComponent(key)}&language=${lang}&page=${page}`;

  const data = await withRetry(() => fetchJSON(url));
  const genres = await tmdbGenres(kind === 'movie' ? 'movie' : 'tv', key, lang);
  return (data.results || []).map((r) => mapTMDB(r, kind, genres));
}

/**
 * Рекомендации MyAnimeList — их составляют сами зрители, поэтому для аниме
 * они обычно точнее жанровых подборок. В ответе только название и постер:
 * год и описание Jikan здесь не отдаёт.
 */
export async function jikanRecommendations(id) {
  const data = await withRetry(() =>
    fetchJSON(`https://api.jikan.moe/v4/anime/${encodeURIComponent(id)}/recommendations`));

  return (data.data || []).slice(0, 20).map(({ entry, votes }) => ({
    id:            `jikan-${entry.mal_id}`,
    type:          'anime',
    title:         entry.title || 'Без названия',
    originalTitle: '',
    year:          null,
    poster:        entry.images?.jpg?.large_image_url || entry.images?.jpg?.image_url || '',
    overview:      '',
    genres:        [],
    source:        'jikan',
    sourceId:      entry.mal_id,
    votes:         votes || 0,
  }));
}

/* ---------------------------------- Jikan --------------------------------- */

async function searchJikan(query, options = {}) {
  const url = `https://api.jikan.moe/v4/anime`
    + `?q=${encodeURIComponent(query)}&limit=20&sfw=true`;

  // В поиске повтор не делаем: быстрее отдать очередь AniList, чем ждать
  // вторую попытку у лежащего Jikan.
  const data = await fetchJSON(url, { timeout: 6000, signal: options.signal });

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
      voteAverage:   a.score || null,
      voteCount:     a.scored_by || 0,
    };
  });
}

/* -------------------------------- AniList --------------------------------- */

/** Запасная аниме-база: нужна, когда Jikan лежит (а он это любит). */
async function searchAniList(query, options = {}) {
  const gql = `query ($q: String) {
    Page(perPage: 20) {
      media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
        id
        title { romaji english native }
        startDate { year }
        coverImage { large }
        description
        episodes
        genres
        popularity
        averageScore
      }
    }
  }`;

  const data = await fetchJSON('https://graphql.anilist.co', {
    timeout: 7000,
    signal: options.signal,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: gql, variables: { q: query } }),
    },
  });

  return (data?.data?.Page?.media || []).map((a) => {
    const title = a.title?.english || a.title?.romaji || a.title?.native || 'Без названия';
    const orig = a.title?.romaji && a.title.romaji !== title ? a.title.romaji : '';
    return {
      id:            `anilist-${a.id}`,
      type:          'anime',
      title,
      originalTitle: orig,
      year:          a.startDate?.year || null,
      poster:        a.coverImage?.large || '',
      overview:      stripHTML(a.description || ''),
      genres:        a.genres || [],
      source:        'anilist',
      sourceId:      a.id,
      episodes:      a.episodes || null,
      popularity:    a.popularity || 0,
      // AniList держит оценку в процентах, приводим к привычной десятке
      voteAverage:   a.averageScore ? Math.round(a.averageScore) / 10 : null,
      voteCount:     0,
    };
  });
}

/** Аниме: сперва Jikan, если не отвечает — AniList. */
async function searchAnime(query, options = {}) {
  try {
    return await searchJikan(query, options);
  } catch (jikanError) {
    try {
      return await searchAniList(query, options);
    } catch {
      throw jikanError;   // сообщаем про основную базу, а не про запасную
    }
  }
}

/* --------------------------------- TVmaze --------------------------------- */

async function searchTVmaze(query, options = {}) {
  const data = await fetchJSON(
    `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`, options);

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

async function searchITunes(query, lang, options = {}) {
  const country = lang === 'ru-RU' ? 'RU' : 'US';
  const url = 'https://itunes.apple.com/search'
    + `?term=${encodeURIComponent(query)}&media=movie&entity=movie`
    + `&limit=20&country=${country}`;

  const data = await fetchJSONP(url, options);

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
 * @returns {Promise<{results:Array, warnings:string[], hasKey:boolean}>}
 */
export async function search(query, type, prefs = {}, options = {}) {
  const q = query.trim();
  const key = (prefs.tmdbKey || '').trim();
  const blank = { results: [], warnings: [], hasKey: Boolean(key), fellBack: false };
  if (q.length < 2) return blank;

  const lang = prefs.lang || 'ru-RU';
  const { signal, onUpdate } = options;
  const want = (t) => type === 'all' || type === t;
  const net = { signal };

  // Аниме-база нужна при любом раскладе: у TMDB она неполная.
  const animeJobs = want('anime') ? [['аниме-база', () => searchAnime(q, net)]] : [];

  const freeJobs = [
    ...(want('movie')  ? [['база фильмов (iTunes)',  () => searchITunes(q, lang, net)]] : []),
    ...(want('series') ? [['база сериалов (TVmaze)', () => searchTVmaze(q, net)]] : []),
  ];

  const tmdbJobs = key ? [
    // Аниме в TMDB лежит среди фильмов и сериалов, поэтому для вкладки
    // «Аниме» тоже нужны оба запроса — тип разберём после ответа.
    ...(want('movie')  || want('anime') ? [['TMDB', () => searchTMDB(q, 'movie', { key, lang, signal })]] : []),
    ...(want('series') || want('anime') ? [['TMDB', () => searchTMDB(q, 'tv',    { key, lang, signal })]] : []),
  ] : [];

  const collected = [];
  const failed = [];
  let fellBack = false;

  const snapshot = () => {
    // Тип у результатов TMDB уточняется уже после ответа, поэтому лишнее
    // отсеиваем здесь, а не на этапе выбора запросов.
    const matching = type === 'all' ? collected : collected.filter((r) => r.type === type);
    return {
      results: rank(dedupe(matching), q),
      warnings: [...new Set(failed)],
      hasKey: Boolean(key),
      fellBack,
    };
  };

  /**
   * Источники опрашиваются разом, и выдача обновляется по мере ответов.
   * Раньше ждали, пока ответят все: быстрый Jikan простаивал, пока
   * недоступная TMDB добивала свой таймаут.
   */
  const runJobs = (jobs) => Promise.all(jobs.map(async ([label, run]) => {
    try {
      // Страховка от источника, который не отвечает и не падает: у каждого
      // свой таймаут, но потолок нужен и на случай, если он не сработает.
      const found = await Promise.race([
        run(),
        delay(JOB_DEADLINE).then(() => { throw new Error('deadline'); }),
      ]);
      collected.push(...found);
    } catch {
      failed.push(label);
    }
    if (!signal?.aborted) onUpdate?.(snapshot());
  }));

  // Если TMDB только что падала, не ждём её в одиночку — зовём всех сразу.
  const upfrontBackup = key && tmdbLooksDown();
  if (upfrontBackup) fellBack = true;

  await runJobs([
    ...(key ? tmdbJobs : freeJobs),
    ...(upfrontBackup ? freeJobs : []),
    ...animeJobs,
  ]);

  // TMDB не ответила — не оставляем человека с пустым экраном: бесплатные
  // базы знают меньше русских названий, но это лучше, чем ничего.
  if (key && !upfrontBackup && failed.includes('TMDB') && freeJobs.length && !signal?.aborted) {
    const before = collected.length;
    await runJobs(freeJobs);
    fellBack = collected.length > before;
  }

  return snapshot();
}

/**
 * Проверка ключа. Отличает «ключ неверный» от «TMDB недоступна» — без этого
 * непонятно, чинить настройки или ждать, пока сеть отпустит.
 */
export async function checkTmdbKey(key, lang = 'ru-RU') {
  if (!key) return { ok: false, reason: 'empty' };
  try {
    await fetchJSON(`${TMDB_API}/configuration?api_key=${encodeURIComponent(key)}&language=${lang}`,
                    { timeout: 10000 });
    markTmdbUp();   // связь появилась — снимаем размыкатель, не ждём минуту
    return { ok: true, reason: 'ok' };
  } catch (err) {
    if (err.status === 401) return { ok: false, reason: 'bad-key' };
    if (err.status) return { ok: false, reason: 'server', status: err.status };
    return { ok: false, reason: 'unreachable' };
  }
}

/** Насколько источнику стоит доверять, если один и тот же тайтл пришёл дважды. */
const SOURCE_RANK = { tmdb: 4, jikan: 3, anilist: 2, tvmaze: 1, itunes: 1 };

/** Схлопывает дубли: один тайтл легко приходит сразу из двух баз. */
function dedupe(items) {
  const keyOf = (item) => [
    item.type,
    (item.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''),
    item.year ?? '',
  ].join('|');

  const best = new Map();
  for (const item of items) {
    const k = keyOf(item);
    const prev = best.get(k);
    if (!prev || (SOURCE_RANK[item.source] || 0) > (SOURCE_RANK[prev.source] || 0)) {
      best.set(k, item);
    }
  }
  return [...best.values()];
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
