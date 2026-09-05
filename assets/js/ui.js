/** Отрисовка и мелкие DOM-утилиты. */

export const TYPE_LABEL = {
  movie:  'Фильм',
  series: 'Сериал',
  anime:  'Аниме',
};

export const STATUS_LABEL = {
  watched:  'Просмотрено',
  watching: 'Смотрю',
  planned:  'В планах',
  dropped:  'Брошено',
};

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHTML(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Класс плашки оценки: красная 1–4, жёлтая 5–6, фиолетовая 7–10. */
function scoreClass(rating) {
  if (rating == null) return 'score score--none';
  if (rating <= 4) return 'score score--low';
  if (rating <= 6) return 'score score--mid';
  return 'score';
}

/**
 * Заглушка вместо постера — обложка с первой буквой названия.
 * Цвет выводится из самого названия, поэтому у каждого тайтла он свой
 * и не меняется от запуска к запуску.
 */
export function monogram(title = '') {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;

  // Шаг золотого сечения разводит соседние хеши по всему кругу оттенков —
  // без него кириллица кучкуется в одном цвете и все обложки выходят похожими.
  const hue = Math.round((Math.abs(hash % 997) * 137.508) % 360);
  const letter = (title.trim()[0] || '?').toUpperCase();
  const bg = `linear-gradient(150deg, hsl(${hue}, 44%, 33%), hsl(${(hue + 40) % 360}, 48%, 18%))`;
  return { letter, bg };
}

function posterHTML(item, cls, phCls) {
  const { letter, bg } = monogram(item.title || '');
  if (item.poster) {
    // data-* нужны обработчику ошибок: если картинка не загрузится,
    // он соберёт из них ту же самую заглушку.
    return `<img class="${cls}" src="${escapeHTML(item.poster)}" alt="" loading="lazy" decoding="async"
                 data-letter="${escapeHTML(letter)}" data-bg="${escapeHTML(bg)}">`;
  }
  return `<div class="${cls} ${phCls}" style="background:${bg}">${escapeHTML(letter)}</div>`;
}

/**
 * Карточка в списке.
 * @param {'library'|'search'} mode
 * @param {object|null} saved — запись из коллекции (для режима поиска)
 */
export function itemCard(item, mode, saved = null) {
  const year = item.year ? `<span>${item.year}</span>` : '';
  const type = `<span class="badge badge--${item.type}">${TYPE_LABEL[item.type]}</span>`;

  let side;
  if (mode === 'library') {
    side = `
      <div class="item__side">
        <div class="${scoreClass(item.rating)}">${item.rating ?? '—'}</div>
        <span class="badge badge--${item.status}">${STATUS_LABEL[item.status]}</span>
      </div>`;
  } else {
    side = saved
      ? `<div class="item__side"><div class="item__add is-in" aria-label="Уже в коллекции">✓</div></div>`
      : `<div class="item__side"><div class="item__add" aria-label="Добавить">+</div></div>`;
  }

  const sub = mode === 'library' && item.note
    ? `<p class="item__sub">${escapeHTML(item.note)}</p>`
    : (mode === 'search' && item.overview
        ? `<p class="item__sub">${escapeHTML(item.overview)}</p>` : '');

  return `
    <button class="item" data-id="${escapeHTML(item.id)}" type="button">
      ${posterHTML(item, 'item__poster', 'item__poster--ph')}
      <div class="item__main">
        <h3 class="item__title">${escapeHTML(item.title)}</h3>
        <div class="item__meta">${type}${year}</div>
        ${sub}
      </div>
      ${side}
    </button>`;
}

/** Содержимое шторки: карточка записи с редактированием статуса и оценки. */
export function detailSheet(item, { saved }) {
  const rateButtons = Array.from({ length: 10 }, (_, i) => i + 1)
    .map((n) => `<button class="rate__btn${item.rating === n ? ' is-active' : ''}" data-rate="${n}" type="button">${n}</button>`)
    .join('');

  const statusButtons = Object.entries(STATUS_LABEL)
    .map(([key, label]) =>
      `<button class="seg__btn${item.status === key ? ' is-active' : ''}" data-status="${key}" type="button">${label}</button>`)
    .join('');

  const meta = [
    `<span class="badge badge--${item.type}">${TYPE_LABEL[item.type]}</span>`,
    item.year ? `<span class="badge">${item.year}</span>` : '',
    item.episodes ? `<span class="badge">${item.episodes} эп.</span>` : '',
    ...(item.genres || []).slice(0, 3).map((g) => `<span class="badge">${escapeHTML(g)}</span>`),
  ].filter(Boolean).join('');

  const long = (item.overview || '').length > 260;

  return `
    <div class="detail__head">
      ${posterHTML(item, 'detail__poster', 'detail__poster--ph')}
      <div>
        <h2 class="detail__title">${escapeHTML(item.title)}</h2>
        ${item.originalTitle ? `<p class="detail__orig">${escapeHTML(item.originalTitle)}</p>` : ''}
        <div class="detail__meta">${meta}</div>
      </div>
    </div>

    ${item.overview ? `
      <p class="detail__overview${long ? ' detail__overview--clamp' : ''}" id="d-overview">${escapeHTML(item.overview)}</p>
      ${long ? '<button class="detail__more" id="d-more" type="button">Показать полностью</button>' : ''}
    ` : ''}

    <div class="group">
      <span class="group__label">Статус</span>
      <div class="seg" id="d-status">${statusButtons}</div>
    </div>

    <div class="group">
      <span class="group__label">Оценка ${item.rating ? `— ${item.rating}/10` : ''}</span>
      <div class="rate" id="d-rate">
        ${rateButtons}
        <button class="rate__clear" id="d-rate-clear" type="button">Убрать оценку</button>
      </div>
    </div>

    <div class="group">
      <span class="group__label">Заметка</span>
      <textarea class="textarea" id="d-note" placeholder="Мысли, с кем смотрел, на чём остановился…">${escapeHTML(item.note || '')}</textarea>
    </div>

    <div class="sheet__actions">
      <button class="btn btn--primary btn--block" id="d-save">${saved ? 'Сохранить' : 'Добавить в коллекцию'}</button>
      ${saved ? '<button class="btn btn--danger btn--block" id="d-delete">Удалить из коллекции</button>' : ''}
      <button class="btn btn--ghost btn--block" id="d-close">Закрыть</button>
    </div>`;
}

/** Форма ручного добавления — когда в базах ничего не нашлось. */
export function manualSheet() {
  const statusButtons = Object.entries(STATUS_LABEL)
    .map(([key, label]) =>
      `<button class="seg__btn${key === 'watched' ? ' is-active' : ''}" data-status="${key}" type="button">${label}</button>`)
    .join('');

  const typeButtons = Object.entries(TYPE_LABEL)
    .map(([key, label]) =>
      `<button class="seg__btn${key === 'movie' ? ' is-active' : ''}" data-mtype="${key}" type="button">${label}</button>`)
    .join('');

  const rateButtons = Array.from({ length: 10 }, (_, i) => i + 1)
    .map((n) => `<button class="rate__btn" data-rate="${n}" type="button">${n}</button>`)
    .join('');

  return `
    <h2 class="detail__title" style="margin-bottom:16px">Добавить вручную</h2>

    <div class="group">
      <span class="group__label">Название</span>
      <input class="field__input field__input--boxed" id="m-title" type="text" placeholder="Например: Достучаться до небес">
    </div>

    <div class="group">
      <span class="group__label">Год</span>
      <input class="field__input field__input--boxed" id="m-year" type="number" inputmode="numeric"
             placeholder="1997" min="1870" max="2100">
    </div>

    <div class="group">
      <span class="group__label">Тип</span>
      <div class="seg" id="m-type">${typeButtons}</div>
    </div>

    <div class="group">
      <span class="group__label">Статус</span>
      <div class="seg" id="m-status">${statusButtons}</div>
    </div>

    <div class="group">
      <span class="group__label">Оценка</span>
      <div class="rate" id="m-rate">
        ${rateButtons}
        <button class="rate__clear" id="m-rate-clear" type="button">Без оценки</button>
      </div>
    </div>

    <div class="group">
      <span class="group__label">Заметка</span>
      <textarea class="textarea" id="m-note" placeholder="Необязательно"></textarea>
    </div>

    <div class="sheet__actions">
      <button class="btn btn--primary btn--block" id="m-save">Добавить</button>
      <button class="btn btn--ghost btn--block" id="d-close">Отмена</button>
    </div>`;
}

/** Экран статистики. */
export function statsView(items) {
  if (!items.length) {
    return `<div class="empty">
      <div class="empty__art">📊</div>
      <p class="empty__title">Считать пока нечего</p>
      <p class="empty__text">Добавь пару тайтлов — тут появятся оценки, распределение и топ.</p>
    </div>`;
  }

  const rated = items.filter((i) => i.rating != null);
  const avg = rated.length
    ? (rated.reduce((s, i) => s + i.rating, 0) / rated.length).toFixed(1)
    : '—';

  const byType = (t) => items.filter((i) => i.type === t).length;
  const watched = items.filter((i) => i.status === 'watched').length;

  const dist = Array.from({ length: 10 }, (_, i) =>
    rated.filter((r) => r.rating === 10 - i).length);
  const maxDist = Math.max(1, ...dist);

  const bars = dist.map((n, idx) => {
    const score = 10 - idx;
    return `<div class="bar">
      <span class="bar__k">${score}</span>
      <div class="bar__track"><div class="bar__fill" style="width:${(n / maxDist) * 100}%"></div></div>
      <span class="bar__n">${n}</span>
    </div>`;
  }).join('');

  const top = [...rated]
    .sort((a, b) => b.rating - a.rating || new Date(b.addedAt) - new Date(a.addedAt))
    .slice(0, 10)
    .map((i, idx) => `<div class="rank__row">
        <span class="rank__i">${idx + 1}</span>
        <span class="rank__t">${escapeHTML(i.title)}</span>
        <span class="rank__s">${i.rating}</span>
      </div>`).join('');

  return `
    <div class="stat-grid">
      <div class="stat"><div class="stat__value">${items.length}</div><div class="stat__label">Всего в коллекции</div></div>
      <div class="stat"><div class="stat__value">${avg}</div><div class="stat__label">Средняя оценка</div></div>
      <div class="stat"><div class="stat__value">${watched}</div><div class="stat__label">Просмотрено</div></div>
      <div class="stat"><div class="stat__value">${rated.length}</div><div class="stat__label">С оценкой</div></div>
    </div>

    <div class="stat-grid stat-grid--3">
      <div class="stat"><div class="stat__value">${byType('movie')}</div><div class="stat__label">🎬 Фильмы</div></div>
      <div class="stat"><div class="stat__value">${byType('series')}</div><div class="stat__label">📺 Сериалы</div></div>
      <div class="stat"><div class="stat__value">${byType('anime')}</div><div class="stat__label">🌸 Аниме</div></div>
    </div>

    <div class="card">
      <h2 class="card__title">Распределение оценок</h2>
      <div class="bars">${bars}</div>
    </div>

    ${top ? `<div class="card">
      <h2 class="card__title">Топ по оценке</h2>
      <div class="rank">${top}</div>
    </div>` : ''}`;
}

/* --------------------------------- тост ---------------------------------- */

let toastTimer = null;

export function toast(message, kind = 'ok') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast${kind === 'error' ? ' toast--error' : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'error' ? 4200 : 2200);
}
