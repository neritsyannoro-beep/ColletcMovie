/** Точка входа: маршрутизация между экранами, фильтры, поиск, шторка, настройки. */

import * as store from './store.js';
import { search as searchProviders, tmdbDetails, jikanDetails } from './providers.js';
import { recommend, clearCache as clearRecsCache } from './recs.js';
import {
  $, $$, itemCard, detailSheet, manualSheet, statsView, toast, voteBadge,
} from './ui.js';

/* -------------------------------- состояние ------------------------------- */

const libFilters = { query: '', type: 'all', status: 'all', sort: 'added_desc' };
const searchState = { query: '', type: 'all', results: [], seq: 0 };
// Подборки держим по категориям: одна общая переменная приводила к тому,
// что при возврате на вкладку показывались результаты предыдущей.
const recsState   = { type: 'movie', byType: new Map(), seq: 0, round: 0 };

let sheetDraft = null;      // { item, saved, status, rating, note, isManual }

/* ------------------------------ маршрутизация ----------------------------- */

function goto(name) {
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.goto === name));
  window.scrollTo(0, 0);
  if (name === 'recs')     loadRecs();
  if (name === 'stats')    renderStats();
  if (name === 'settings') refreshStorageInfo();
  if (name === 'search')   setTimeout(() => $('#search-input').focus(), 120);
  // replaceState, а не location.hash: иначе каждая вкладка плодит запись в истории
  try { history.replaceState(history.state, '', name === 'library' ? '#' : `#${name}`); }
  catch { /* приватный режим */ }
}

/* -------------------------------- библиотека ------------------------------ */

function filteredLibrary() {
  const q = libFilters.query.trim().toLowerCase();

  const items = store.all().filter((i) => {
    if (libFilters.type   !== 'all' && i.type   !== libFilters.type)   return false;
    if (libFilters.status !== 'all' && i.status !== libFilters.status) return false;
    if (!q) return true;
    return i.title.toLowerCase().includes(q)
        || (i.originalTitle || '').toLowerCase().includes(q)
        || (i.note || '').toLowerCase().includes(q);
  });

  const byDate  = (a, b, dir) => dir * (new Date(a.addedAt) - new Date(b.addedAt));
  const sorters = {
    added_desc:  (a, b) => byDate(a, b, -1),
    added_asc:   (a, b) => byDate(a, b, 1),
    // Записи без оценки всегда в конце — независимо от направления.
    rating_desc: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
    rating_asc:  (a, b) => (a.rating ?? 99) - (b.rating ?? 99),
    title_asc:   (a, b) => a.title.localeCompare(b.title, 'ru'),
    year_desc:   (a, b) => (b.year ?? 0) - (a.year ?? 0),
  };

  return items.sort(sorters[libFilters.sort] || sorters.added_desc);
}

function renderLibrary() {
  const items = filteredLibrary();
  const list  = $('#lib-list');
  const empty = $('#lib-empty');

  $('#lib-count').textContent = store.all().length;
  renderBackupNudge();

  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    const hasAny = store.all().length > 0;
    $('.empty__title', empty).textContent = hasAny ? 'Ничего не нашлось' : 'Пока пусто';
    $('.empty__text', empty).textContent = hasAny
      ? 'Попробуй сбросить фильтры или изменить запрос.'
      : 'Найди фильм, сериал или аниме на вкладке «Поиск» и добавь в коллекцию.';
    $('.btn', empty).hidden = hasAny;
    return;
  }

  empty.hidden = true;
  list.innerHTML = items.map((i) => itemCard(i, 'library')).join('');
}

/* --------------------------------- поиск ---------------------------------- */

let searchTimer = null;

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 420);
}

async function runSearch() {
  const q = searchState.query.trim();
  const list   = $('#search-list');
  const idle   = $('#search-idle');
  const status = $('#search-status');

  if (q.length < 2) {
    list.innerHTML = '';
    status.hidden = true;
    idle.hidden = false;
    $('#search-tip').hidden = true;
    return;
  }

  idle.hidden = true;
  status.hidden = false;
  status.className = 'hint';
  status.innerHTML = '<span class="spinner"></span>Ищу…';

  const seq = ++searchState.seq;
  let payload;
  try {
    payload = await searchProviders(q, searchState.type, store.getPrefs());
  } catch (err) {
    if (seq !== searchState.seq) return;
    status.className = 'hint hint--error';
    status.textContent = `Поиск не сработал: ${err.message}`;
    return;
  }
  if (seq !== searchState.seq) return;   // пришёл ответ на устаревший запрос

  searchState.results = payload.results;

  // Подсказка про ключ уместна ровно тогда, когда выдача бедная.
  $('#search-tip').hidden = payload.hasKey || payload.results.length >= 5;

  const failed = payload.warnings.length
    ? `Не ответила ${payload.warnings.join(' и ')}`
    : '';

  if (!payload.results.length) {
    list.innerHTML = '';
    status.className = failed ? 'hint hint--error' : 'hint';
    status.textContent = failed
      ? `${failed}. Попробуй ещё раз через минуту или добавь вручную.`
      : 'Ничего не нашлось. Попробуй оригинальное название или добавь вручную.';
    return;
  }

  status.hidden = !failed;
  if (failed) {
    status.className = 'hint';
    status.textContent = `${failed} — показываю то, что нашли остальные.`;
  }

  list.innerHTML = payload.results
    .map((r) => itemCard(r, 'search', store.get(r.id)))
    .join('');
}

/* --------------------------------- шторка --------------------------------- */

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  // Отдельная запись в истории, чтобы системная «Назад» закрывала шторку.
  try { history.pushState({ cmSheet: true }, ''); } catch { /* приватный режим */ }
}

/** @param {boolean} fromHistory — вызов пришёл из popstate, назад ходить не надо */
function closeSheet(fromHistory = false) {
  if ($('#sheet').hidden) return;
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#sheet-body').innerHTML = '';
  document.body.style.overflow = '';
  sheetDraft = null;
  if (!fromHistory && history.state?.cmSheet) {
    try { history.back(); } catch { /* приватный режим */ }
  }
}

/** Открывает карточку записи — из коллекции или из выдачи поиска. */
function openDetail(id, { defaultStatus = 'watched' } = {}) {
  const saved = store.get(id);
  const found = saved
    || searchState.results.find((r) => r.id === id)
    || findInRecs(id);
  if (!found) return;

  // Для новой записи ставим разумные значения по умолчанию.
  const item = saved ? { ...found } : { ...found, status: defaultStatus, rating: null, note: '' };

  sheetDraft = {
    item,
    saved: Boolean(saved),
    status: item.status,
    rating: item.rating,
    note:   item.note || '',
    isManual: false,
  };

  openSheet(detailSheet(item, { saved: Boolean(saved) }));
  if (item.voteAverage == null) fillVote(item);
}

/**
 * Дотягивает оценку базы для карточек, где её нет: записи, добавленные до
 * появления этой плашки, и рекомендации MyAnimeList — там в ответе только
 * название с постером.
 */
async function fillVote(item) {
  const prefs = store.getPrefs();
  let details = null;

  try {
    if (item.source === 'tmdb' && item.sourceId) {
      if (!prefs.tmdbKey) return;
      const kind = item.id.startsWith('tmdb-movie') ? 'movie' : 'tv';
      details = await tmdbDetails(kind, item.sourceId, { key: prefs.tmdbKey, lang: prefs.lang });
    } else if (item.source === 'jikan' && item.sourceId) {
      details = await jikanDetails(item.sourceId);
    }
  } catch {
    return;   // без оценки карточка вполне живая
  }
  if (!details?.voteAverage) return;

  // Шторку могли успеть закрыть или открыть другую.
  if (!sheetDraft || sheetDraft.item.id !== item.id) return;

  Object.assign(sheetDraft.item, {
    voteAverage: details.voteAverage,
    voteCount:   details.voteCount,
    episodes:    sheetDraft.item.episodes || details.episodes || null,
    overview:    sheetDraft.item.overview || details.overview || '',
    genres:      sheetDraft.item.genres?.length ? sheetDraft.item.genres : details.genres,
  });

  const slot = $('#d-vote');
  if (slot) slot.innerHTML = voteBadge(sheetDraft.item);

  // Если тайтл уже в коллекции — сохраняем, чтобы в следующий раз не ходить в сеть.
  if (sheetDraft.saved) {
    store.upsert({ ...store.get(item.id), voteAverage: details.voteAverage, voteCount: details.voteCount });
    renderLibrary();
  }
}

function openManual() {
  sheetDraft = { item: null, saved: false, status: 'watched', rating: null, note: '', isManual: true, type: 'movie' };
  openSheet(manualSheet());
}

/** Одна обработка кликов на всю шторку — проще, чем вешать листенеры на каждый узел. */
function onSheetClick(event) {
  const target = event.target.closest('button');
  if (!target || !sheetDraft) return;

  // --- оценка ---
  if (target.dataset.rate) {
    const value = Number(target.dataset.rate);
    sheetDraft.rating = sheetDraft.rating === value ? null : value;   // повторный тап снимает
    $$('[data-rate]').forEach((b) =>
      b.classList.toggle('is-active', Number(b.dataset.rate) === sheetDraft.rating));
    const label = target.closest('.group')?.querySelector('.group__label');
    if (label && !sheetDraft.isManual) {
      label.textContent = sheetDraft.rating ? `Оценка — ${sheetDraft.rating}/10` : 'Оценка';
    }
    return;
  }

  if (target.id === 'd-rate-clear' || target.id === 'm-rate-clear') {
    sheetDraft.rating = null;
    $$('[data-rate]').forEach((b) => b.classList.remove('is-active'));
    return;
  }

  // --- статус ---
  if (target.dataset.status) {
    sheetDraft.status = target.dataset.status;
    $$('#d-status .seg__btn, #m-status .seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.status === sheetDraft.status));
    return;
  }

  // --- тип (только ручное добавление) ---
  if (target.dataset.mtype) {
    sheetDraft.type = target.dataset.mtype;
    $$('#m-type .seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.mtype === sheetDraft.type));
    return;
  }

  if (target.id === 'd-more') {
    $('#d-overview').classList.remove('detail__overview--clamp');
    target.remove();
    return;
  }

  if (target.id === 'd-close') { closeSheet(); return; }

  if (target.id === 'd-save')   { saveFromSheet(); return; }
  if (target.id === 'm-save')   { saveManual();    return; }
  if (target.id === 'd-delete') { deleteFromSheet(); return; }
}

function saveFromSheet() {
  const note = $('#d-note')?.value.trim() ?? '';
  const wasSaved = sheetDraft.saved;

  const { because, ...item } = sheetDraft.item;   // because — только для показа
  store.upsert({
    ...item,
    status: sheetDraft.status,
    rating: sheetDraft.rating,
    note,
  });

  closeSheet();
  renderLibrary();
  runSearchRefresh();
  refreshRecsMarks();
  toast(wasSaved ? 'Сохранено' : 'Добавлено в коллекцию');
}

function saveManual() {
  const title = $('#m-title').value.trim();
  if (!title) { toast('Впиши название', 'error'); return; }

  const yearRaw = parseInt($('#m-year').value, 10);
  const year = Number.isFinite(yearRaw) && yearRaw > 1870 && yearRaw < 2100 ? yearRaw : null;

  store.upsert({
    id:     `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type:   sheetDraft.type,
    title,
    year,
    source: 'manual',
    status: sheetDraft.status,
    rating: sheetDraft.rating,
    note:   $('#m-note').value.trim(),
  });

  closeSheet();
  renderLibrary();
  goto('library');
  toast('Добавлено вручную');
}

function deleteFromSheet() {
  if (!confirm(`Удалить «${sheetDraft.item.title}» из коллекции?`)) return;
  store.remove(sheetDraft.item.id);
  closeSheet();
  renderLibrary();
  runSearchRefresh();
  refreshRecsMarks();
  toast('Удалено');
}

/** Перерисовывает галочки «уже в коллекции» в открытой выдаче поиска. */
function runSearchRefresh() {
  if ($('#screen-search').hidden || !searchState.results.length) return;
  $('#search-list').innerHTML = searchState.results
    .map((r) => itemCard(r, 'search', store.get(r.id)))
    .join('');
}

/* --------------------------------- советы --------------------------------- */

const RECS_EMPTY = {
  'no-seeds': {
    movie:  ['Пока не из чего исходить', 'Оцени несколько просмотренных фильмов — и здесь появятся похожие.'],
    series: ['Пока не из чего исходить', 'Оцени несколько просмотренных сериалов — и здесь появятся похожие.'],
    anime:  ['Пока не из чего исходить', 'Оцени несколько просмотренных аниме — и здесь появятся похожие.'],
  },
  'need-key': {
    all: ['Нужен ключ TMDB', 'Советы строятся на базе TMDB. Ключ бесплатный и добавляется за минуту.'],
  },
  failed: {
    all: ['Не получилось собрать', 'Базы не ответили. Попробуй обновить через минуту.'],
  },
};

async function loadRecs({ force = false } = {}) {
  const type   = recsState.type;
  const list   = $('#recs-list');
  const empty  = $('#recs-empty');
  const status = $('#recs-status');
  const refresh = $('#recs-refresh');

  // Повторно на ту же вкладку не ходим: подборка уже посчитана и закэширована.
  const ready = recsState.byType.get(type);
  if (!force && ready?.length) {
    renderRecs(ready);
    return;
  }

  const seq = ++recsState.seq;
  list.innerHTML = '';
  empty.hidden = true;
  status.hidden = false;
  status.className = 'hint';
  status.innerHTML = '<span class="spinner"></span>Подбираю по твоим оценкам…';
  refresh.classList.add('is-busy');

  let payload;
  try {
    payload = await recommend(type, store.getPrefs(), { force, round: recsState.round });
  } catch {
    payload = { items: [], status: 'failed' };
  } finally {
    if (seq === recsState.seq) refresh.classList.remove('is-busy');
  }
  if (seq !== recsState.seq) return;

  status.hidden = true;

  if (!payload.items.length) {
    recsState.byType.delete(type);
    const texts = RECS_EMPTY[payload.status] || RECS_EMPTY.failed;
    const [title, text] = texts[type] || texts.all;
    $('.empty__title', empty).textContent = title;
    $('.empty__text', empty).textContent = text;
    const btn = $('#recs-empty-btn');
    btn.hidden = payload.status !== 'need-key';
    btn.textContent = 'Добавить ключ';
    empty.hidden = false;
    return;
  }

  recsState.byType.set(type, payload.items);
  renderRecs(payload.items);
}

function renderRecs(items) {
  $('#recs-empty').hidden = true;
  $('#recs-list').innerHTML = items
    .map((r) => itemCard(r, 'search', store.get(r.id)))
    .join('');
}

/** Обновляет галочки «уже в коллекции» в открытой подборке. */
function refreshRecsMarks() {
  const current = recsState.byType.get(recsState.type);
  if ($('#screen-recs').hidden || !current?.length) return;
  renderRecs(current);
}

/** Ищет карточку среди всех посчитанных подборок, а не только текущей. */
function findInRecs(id) {
  for (const items of recsState.byType.values()) {
    const hit = items.find((r) => r.id === id);
    if (hit) return hit;
  }
  return null;
}

function wireRecs() {
  $('#recs-type-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.dataset.type === recsState.type) return;
    recsState.type = chip.dataset.type;
    $$('#recs-type-chips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    loadRecs();
  });

  $('#recs-refresh').addEventListener('click', () => {
    // Новый круг — другая восьмёрка источников, иначе выдача не изменится.
    recsState.round += 1;
    recsState.byType.delete(recsState.type);
    loadRecs({ force: true });
  });

  $('#recs-list').addEventListener('click', (e) => {
    const card = e.target.closest('.item');
    // Из советов логично добавлять в «В планах» — это же то, что ещё не смотрел.
    if (card) openDetail(card.dataset.id, { defaultStatus: 'planned' });
  });
}

/* ------------------------------- статистика ------------------------------- */

function renderStats() {
  $('#stats-body').innerHTML = statsView(store.all());
}

/* -------------------------------- настройки ------------------------------- */

/** «1 запись», «2 записи», «5 записей». */
function plural(n, one, few, many) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

async function refreshStorageInfo() {
  refreshBackupInfo();
  const { bytes, quota, persisted, count } = await store.usage();
  const kb = (bytes / 1024).toFixed(1);
  const quotaText = quota ? `, доступно ~${(quota / 1024 / 1024).toFixed(0)} МБ` : '';
  const persistText = persisted
    ? 'Браузер пометил данные как защищённые от автоочистки.'
    : 'Совет: добавь приложение на главный экран — так браузер не удалит данные при чистке кэша.';
  $('#storage-info').textContent =
    `${count} ${plural(count, 'запись', 'записи', 'записей')}, ${kb} КБ${quotaText}. ${persistText}`;
}

const DAY = 24 * 60 * 60 * 1000;
const BACKUP_REMIND_AFTER = 14 * DAY;

/**
 * Сохраняет бэкап.
 *
 * На айфоне ссылка с download в установленном приложении часто не скачивает
 * файл, а открывает его во вкладке — поэтому сначала пробуем системное
 * «Поделиться»: оттуда файл кладётся в «Файлы», iCloud или мессенджер.
 * Обычная ссылка остаётся запасным путём для десктопа и Android.
 */
async function exportBackup() {
  const json  = store.exportJSON();
  const stamp = new Date().toISOString().slice(0, 10);
  const name  = `collectmovie-${stamp}.json`;

  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Резервная копия CollectMovie' });
      markBackedUp('Копия сохранена');
      return;
    } catch (err) {
      // Пользователь закрыл шторку — это не ошибка и бэкапом не считается.
      if (err?.name === 'AbortError') return;
      // Всё остальное — пробуем обычную ссылку.
    }
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  markBackedUp('Файл бэкапа готов');
}

function markBackedUp(message) {
  store.setPrefs({ lastBackupAt: new Date().toISOString() });
  renderBackupNudge();
  refreshBackupInfo();
  toast(message);
}

/** Форматирует «сегодня / 3 дня назад / 12.08.2026». */
function agoText(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / DAY);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return new Date(iso).toLocaleDateString('ru-RU');
}

/** Напоминание в библиотеке: копии нет вообще или она давно устарела. */
function renderBackupNudge() {
  const nudge = $('#backup-nudge');
  const count = store.all().length;
  const { lastBackupAt } = store.getPrefs();

  if (!count) { nudge.hidden = true; return; }

  const stale = !lastBackupAt || (Date.now() - new Date(lastBackupAt)) > BACKUP_REMIND_AFTER;
  nudge.hidden = !stale;
  if (!stale) return;

  $('#nudge-title').textContent = lastBackupAt
    ? 'Резервная копия устарела'
    : 'Коллекция без резервной копии';
  $('#nudge-sub').textContent = lastBackupAt
    ? `Последняя — ${agoText(lastBackupAt)}. Смени телефон — потеряешь всё после неё.`
    : `${count} ${plural(count, 'запись', 'записи', 'записей')} живут только на этом телефоне.`;
}

function refreshBackupInfo() {
  const { lastBackupAt } = store.getPrefs();
  $('#backup-info').textContent = lastBackupAt
    ? `Последняя резервная копия — ${agoText(lastBackupAt)}.`
    : 'Резервную копию ещё ни разу не делали.';
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const replace = confirm(
      'OK — заменить коллекцию содержимым файла.\n' +
      'Отмена — добавить записи из файла к текущим (ничего не потеряется).');
    try {
      const res = store.importJSON(String(reader.result), replace ? 'replace' : 'merge');
      renderLibrary();
      refreshStorageInfo();
      toast(`Готово: +${res.added}, обновлено ${res.updated}, всего ${res.total}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  reader.onerror = () => toast('Не смог прочитать файл', 'error');
  reader.readAsText(file);
}

/* ------------------------------ инициализация ----------------------------- */

function wireLibrary() {
  const input = $('#lib-search');
  input.addEventListener('input', () => {
    libFilters.query = input.value;
    $('#lib-search-clear').hidden = !input.value;
    renderLibrary();
  });
  $('#lib-search-clear').addEventListener('click', () => {
    input.value = '';
    libFilters.query = '';
    $('#lib-search-clear').hidden = true;
    renderLibrary();
  });

  $('#lib-type-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    libFilters.type = chip.dataset.type;
    $$('#lib-type-chips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    renderLibrary();
  });

  $('#lib-status-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    libFilters.status = chip.dataset.status;
    $$('#lib-status-chips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    renderLibrary();
  });

  $('#lib-sort').addEventListener('change', (e) => {
    libFilters.sort = e.target.value;
    renderLibrary();
  });

  $('#lib-list').addEventListener('click', (e) => {
    const card = e.target.closest('.item');
    if (card) openDetail(card.dataset.id);
  });
}

function wireSearch() {
  const input = $('#search-input');
  input.addEventListener('input', () => {
    searchState.query = input.value;
    $('#search-clear').hidden = !input.value;
    scheduleSearch();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); clearTimeout(searchTimer); runSearch(); }
  });

  $('#search-clear').addEventListener('click', () => {
    input.value = '';
    searchState.query = '';
    searchState.results = [];
    $('#search-clear').hidden = true;
    runSearch();
    input.focus();
  });

  $('#search-type-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    searchState.type = chip.dataset.type;
    $$('#search-type-chips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    clearTimeout(searchTimer);
    runSearch();
  });

  $('#search-list').addEventListener('click', (e) => {
    const card = e.target.closest('.item');
    if (card) openDetail(card.dataset.id);
  });

  $('#btn-manual-add').addEventListener('click', openManual);
}

function wireSettings() {
  const prefs = store.getPrefs();
  $('#tmdb-key').value = prefs.tmdbKey || '';
  $('#tmdb-lang').value = prefs.lang || 'ru-RU';

  $('#btn-save-key').addEventListener('click', () => {
    store.setPrefs({ tmdbKey: $('#tmdb-key').value.trim() });
    resetRecs();
    toast($('#tmdb-key').value.trim() ? 'Ключ сохранён' : 'Ключ очищен');
  });

  $('#btn-clear-key').addEventListener('click', () => {
    $('#tmdb-key').value = '';
    store.setPrefs({ tmdbKey: '' });
    resetRecs();
    toast('Ключ удалён — поиск снова через бесплатные базы');
  });

  $('#tmdb-lang').addEventListener('change', (e) => {
    store.setPrefs({ lang: e.target.value });
    resetRecs();
    toast('Язык поиска обновлён');
  });

  $('#btn-export').addEventListener('click', exportBackup);
  $('#nudge-btn').addEventListener('click', exportBackup);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importBackup(file);
    e.target.value = '';
  });

  $('#btn-wipe').addEventListener('click', () => {
    if (!confirm('Удалить ВСЮ коллекцию без возможности отката?\nСначала лучше скачать бэкап.')) return;
    if (!confirm('Точно? Это последний вопрос.')) return;
    store.wipe();
    resetRecs();
    renderLibrary();
    refreshStorageInfo();
    toast('Коллекция очищена');
  });
}

/** Сбрасывает посчитанные подборки — после смены ключа, языка или коллекции. */
function resetRecs() {
  clearRecsCache();
  recsState.byType.clear();
  recsState.round = 0;
}

function wireGlobal() {
  $('#tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) goto(tab.dataset.goto);
  });

  document.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-goto]:not(.tab)');
    if (jump) goto(jump.dataset.goto);
  });

  $('#sheet-body').addEventListener('click', onSheetClick);
  $('#sheet-backdrop').addEventListener('click', () => closeSheet());
  $('#sheet-grab').addEventListener('click', () => closeSheet());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  // Свайп вниз по «ручке» закрывает шторку.
  let dragStart = null;
  const grab = $('#sheet-grab');
  grab.addEventListener('touchstart', (e) => { dragStart = e.touches[0].clientY; }, { passive: true });
  grab.addEventListener('touchmove', (e) => {
    if (dragStart != null && e.touches[0].clientY - dragStart > 60) { dragStart = null; closeSheet(); }
  }, { passive: true });
  grab.addEventListener('touchend', () => { dragStart = null; });

  // Постер не загрузился — подставляем ту же обложку-монограмму.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const isDetail = img.classList.contains('detail__poster');
    if (!isDetail && !img.classList.contains('item__poster')) return;
    const ph = document.createElement('div');
    ph.className = isDetail ? 'detail__poster detail__poster--ph' : 'item__poster item__poster--ph';
    ph.style.background = img.dataset.bg || '';
    ph.textContent = img.dataset.letter || '?';
    img.replaceWith(ph);
  }, true);

  window.addEventListener('store:error', (e) => toast(e.detail, 'error'));

  window.addEventListener('popstate', () => {
    if (!$('#sheet').hidden) closeSheet(true);
  });
}

async function init() {
  await store.load();

  wireGlobal();
  wireLibrary();
  wireSearch();
  wireRecs();
  wireSettings();

  renderLibrary();

  const start = location.hash.replace('#', '');
  goto(['search', 'recs', 'stats', 'settings'].includes(start) ? start : 'library');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн-режим необязателен */ });
  }
}

init();
