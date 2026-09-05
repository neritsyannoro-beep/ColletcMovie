/**
 * Сквозные тесты в мобильном Chromium. Внешние API замоканы, так что тесты
 * не зависят от сети и от лимитов Jikan/TMDB.
 *
 *   npx http-server -p 8099 -c-1 &
 *   node tests/e2e.mjs
 */
import { chromium, devices } from 'playwright';

const BASE = 'http://127.0.0.1:8099/';
const errors = [];
const checks = [];
const ok = (name, cond, extra='') => { checks.push([cond?'PASS':'FAIL', name, extra]); if(!cond) errors.push(name); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();

// Постеры ведут на внешние домены, а один запрос к TMDB намеренно отвечает 401 —
// такие сообщения в консоли ожидаемы и ошибкой приложения не являются.
const EXPECTED = /Failed to load resource/;
page.on('console', m => {
  if (m.type() === 'error' && !EXPECTED.test(m.text())) errors.push('console: ' + m.text());
});
page.on('pageerror', e => errors.push('pageerror: '+e.message));

// ---- моки внешних API ----
await page.route('**/api.jikan.moe/**', r => r.fulfill({ contentType:'application/json', body: JSON.stringify({ data:[
  { mal_id: 5114, title:'Fullmetal Alchemist: Brotherhood', title_english:'Fullmetal Alchemist: Brotherhood',
    images:{jpg:{large_image_url:'', image_url:''}}, year:2009, aired:{from:'2009-04-05'},
    synopsis:'Братья Элрики ищут философский камень.', genres:[{name:'Action'},{name:'Drama'}], episodes:64, members:3000000 }
]})}));

await page.route('**/api.tvmaze.com/**', r => r.fulfill({ contentType:'application/json', body: JSON.stringify([
  { score: 0.9, show:{ id:169, name:'Breaking Bad', premiered:'2008-01-20', image:null,
    summary:'<p><b>Breaking Bad</b> follows Walter White.</p>', genres:['Drama','Crime'], weight:99 } }
])}));

// iTunes идёт через JSONP (script tag)
await page.route('**/itunes.apple.com/**', async route => {
  const url = new URL(route.request().url());
  const cb = url.searchParams.get('callback');
  const body = `${cb}(${JSON.stringify({ resultCount:1, results:[
    { trackId: 431997, trackName:'Начало', releaseDate:'2010-07-16T07:00:00Z',
      artworkUrl100:'https://example.test/a/100x100bb.jpg', longDescription:'Дом Кобб — вор.',
      primaryGenreName:'Триллер' }]})})`;
  await route.fulfill({ contentType:'text/javascript', body });
});

try {
// ---- 1. загрузка ----
await page.goto(BASE, { waitUntil:'networkidle' });
ok('страница загрузилась', await page.title() !== '');
ok('видна библиотека', await page.locator('#screen-library').isVisible());
ok('пустое состояние', await page.locator('#lib-empty').isVisible());
ok('нет горизонтального скролла',
   await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
   await page.evaluate(() => document.documentElement.scrollWidth + ' vs ' + window.innerWidth));

// ---- 2. поиск ----
await page.locator('.tab[data-goto="search"]').click();
await page.locator('#search-input').fill('breaking');
await page.waitForSelector('#search-list .item', { timeout: 8000 });
const n = await page.locator('#search-list .item').count();
ok('поиск вернул результаты', n >= 3, `найдено ${n}`);
const titles = await page.locator('#search-list .item__title').allTextContents();
ok('есть фильм из iTunes', titles.some(t=>t.includes('Начало')), titles.join(' | '));
ok('есть сериал из TVmaze', titles.some(t=>t.includes('Breaking Bad')));
ok('есть аниме из Jikan', titles.some(t=>t.includes('Fullmetal')));
ok('HTML из TVmaze очищен',
   !(await page.locator('#search-list').innerHTML()).includes('<b>Breaking Bad</b>'));

// ---- 3. добавление с оценкой ----
await page.locator('#search-list .item', { hasText: 'Breaking Bad' }).click();
await page.waitForSelector('#sheet:not([hidden])');
ok('шторка открылась', await page.locator('#sheet').isVisible());
await page.locator('.rate__btn[data-rate="9"]').click();
ok('оценка 9 выбрана', await page.locator('.rate__btn[data-rate="9"]').getAttribute('class').then(c=>c.includes('is-active')));
await page.locator('.seg__btn[data-status="watched"]').click();
await page.locator('#d-note').fill('Лучший сериал');
await page.locator('#d-save').click();
await page.waitForSelector('#sheet', { state: 'hidden' });
ok('вернулись без шторки', await page.locator('#sheet').isHidden());

// ---- 4. запись в коллекции ----
await page.locator('.tab[data-goto="library"]').click();
await page.waitForSelector('#lib-list .item');
ok('счётчик = 1', (await page.locator('#lib-count').textContent()) === '1');
ok('оценка отображается', (await page.locator('#lib-list .score').first().textContent()).trim() === '9');
ok('статус просмотрено', (await page.locator('#lib-list .badge--watched').count()) === 1);
ok('заметка видна', (await page.locator('#lib-list .item__sub').textContent()).includes('Лучший'));

// ---- 5. галочка в поиске ----
await page.locator('.tab[data-goto="search"]').click();
await page.waitForSelector('#search-list .item');
ok('в поиске стоит галочка', (await page.locator('#search-list .item__add.is-in').count()) === 1);

// ---- 6. ручное добавление ----
await page.locator('#btn-manual-add').click();
await page.waitForSelector('#m-title');
await page.locator('#m-title').fill('Достучаться до небес');
await page.locator('#m-year').fill('1997');
await page.locator('.seg__btn[data-mtype="movie"]').click();
await page.locator('#m-rate .rate__btn[data-rate="10"]').click();
await page.locator('#m-save').click();
await page.waitForSelector('#sheet', { state: 'hidden' });
ok('счётчик = 2', (await page.locator('#lib-count').textContent()) === '2');

// ---- 7. фильтры и сортировка ----
await page.locator('#lib-type-chips .chip[data-type="movie"]').click();
ok('фильтр «Фильмы» -> 1', (await page.locator('#lib-list .item').count()) === 1);
await page.locator('#lib-type-chips .chip[data-type="series"]').click();
ok('фильтр «Сериалы» -> 1', (await page.locator('#lib-list .item').count()) === 1);
await page.locator('#lib-type-chips .chip[data-type="anime"]').click();
ok('фильтр «Аниме» -> 0', (await page.locator('#lib-list .item').count()) === 0);
await page.locator('#lib-type-chips .chip[data-type="all"]').click();
await page.selectOption('#lib-sort', 'rating_desc');
const first = await page.locator('#lib-list .item__title').first().textContent();
ok('сортировка по оценке: 10 сверху', first.includes('Достучаться'), first);

// поиск внутри библиотеки
await page.locator('#lib-search').fill('небес');
ok('поиск по коллекции', (await page.locator('#lib-list .item').count()) === 1);
await page.locator('#lib-search-clear').click();
ok('сброс поиска', (await page.locator('#lib-list .item').count()) === 2);

// ---- 8. статистика ----
await page.locator('.tab[data-goto="stats"]').click();
await page.waitForSelector('#stats-body .stat');
const statVals = await page.locator('#stats-body .stat__value').allTextContents();
ok('всего = 2', statVals[0] === '2', statVals.join(','));
ok('средняя = 9.5', statVals[1] === '9.5', statVals.join(','));

// ---- 9. персистентность после перезагрузки ----
await page.reload({ waitUntil:'networkidle' });
await page.waitForTimeout(500);
ok('вкладка восстановилась из hash', await page.locator('#screen-stats').isVisible());
await page.locator('.tab[data-goto="library"]').click();
await page.waitForSelector('#lib-list .item');
ok('данные пережили перезагрузку', (await page.locator('#lib-count').textContent()) === '2');

// ---- 10. восстановление из IndexedDB после сноса localStorage ----
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil:'networkidle' });
await page.waitForTimeout(800);
await page.locator('.tab[data-goto="library"]').click();
ok('восстановление из IndexedDB', (await page.locator('#lib-count').textContent()) === '2',
   'счётчик: ' + await page.locator('#lib-count').textContent());

// ---- 11. редактирование и удаление ----
await page.locator('.tab[data-goto="library"]').click();
await page.locator('#lib-list .item').first().click();
await page.waitForSelector('#sheet:not([hidden])');
await page.locator('.rate__btn[data-rate="5"]').click();
await page.locator('#d-save').click();
await page.waitForSelector('#sheet', { state: 'hidden' });
const scores = await page.locator('#lib-list .score').allTextContents();
ok('оценка изменилась на 5', scores.map(s=>s.trim()).includes('5'), scores.join(','));

page.on('dialog', d => d.accept());
await page.locator('#lib-list .item').first().click();
await page.waitForSelector('#sheet:not([hidden])');
await page.locator('#d-delete').click();
await page.waitForSelector('#sheet', { state: 'hidden' });
ok('удаление работает', (await page.locator('#lib-count').textContent()) === '1');

// ---- 12. кнопка «Назад» закрывает шторку ----
await page.locator('#lib-list .item').first().click();
await page.waitForSelector('#sheet:not([hidden])');
await page.goBack();
await page.waitForTimeout(300);
ok('назад закрывает шторку', await page.locator('#sheet').isHidden());

// ---- 13. настройки ----
await page.locator('.tab[data-goto="settings"]').click();
await page.waitForFunction(() => document.querySelector('#storage-info').textContent !== '—', null, { timeout: 5000 });
const info = await page.locator('#storage-info').textContent();
ok('инфо о хранилище', /запис(ь|и|ей)/.test(info), info);
await page.locator('#tmdb-key').fill('TESTKEY123');
await page.locator('#btn-save-key').click();
const savedKey = await page.evaluate(() => JSON.parse(localStorage.getItem('collectmovie:prefs')||'{}').tmdbKey);
ok('ключ TMDB сохранён', savedKey === 'TESTKEY123', String(savedKey));

// ---- 14. экспорт ----
const [ download ] = await Promise.all([
  page.waitForEvent('download', { timeout: 5000 }).catch(()=>null),
  page.locator('#btn-export').click(),
]);
ok('экспорт отдаёт файл', !!download && /collectmovie-\d{4}-\d{2}-\d{2}\.json/.test(download.suggestedFilename()),
   download ? download.suggestedFilename() : 'нет download');

// ---- 15. ветка TMDB ----
await page.route('**/api.themoviedb.org/3/genre/**', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ genres:[{id:18,name:'Драма'}] })}));
await page.route('**/api.themoviedb.org/3/search/movie**', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ results:[{ id:27205, title:'Начало', original_title:'Inception',
    release_date:'2010-07-16', poster_path:'/p.jpg', overview:'Описание', genre_ids:[18], popularity:50 }]})}));
await page.route('**/api.themoviedb.org/3/search/tv**', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ results:[] })}));
await page.locator('.tab[data-goto="search"]').click();
await page.locator('#search-input').fill('inception');
await page.waitForTimeout(1500);
const tmdbTitles = await page.locator('#search-list .item__title').allTextContents();
ok('TMDB-ветка отработала', tmdbTitles.some(t=>t.includes('Начало')), tmdbTitles.join(' | '));

// ---- 16. ошибка ключа TMDB ----
await page.unroute('**/api.themoviedb.org/3/search/movie**');
await page.route('**/api.themoviedb.org/3/search/movie**', r => r.fulfill({ status:401, contentType:'application/json', body:'{}' }));
await page.locator('#search-input').fill('inception2');
await page.waitForTimeout(1800);
const warn = await page.locator('#search-status').textContent();
ok('сбой источника назван по-человечески', /Не ответила/i.test(warn||''), warn||'пусто');


// ---- 18. Jikan лежит -> подхватывается AniList ----
await page.evaluate(() => localStorage.setItem('collectmovie:prefs', '{}'));
await page.reload({ waitUntil:'networkidle' });
await page.route('**/api.jikan.moe/**', r => r.fulfill({ status:504, contentType:'text/html', body:'gateway timeout' }));
await page.route('**/graphql.anilist.co/**', r => r.fulfill({ contentType:'application/json', body: JSON.stringify({
  data:{ Page:{ media:[{ id:97940, title:{ english:'Black Clover', romaji:'Black Clover' },
    startDate:{year:2017}, coverImage:{large:''}, description:'<p>Аста и Юно.</p>',
    episodes:170, genres:['Action'], popularity:500000 }]}}})}));
await page.locator('.tab[data-goto="search"]').click();
await page.locator('#search-input').fill('black clover');
await page.waitForSelector('#search-list .item', { timeout: 15000 });
const fbTitles = await page.locator('#search-list .item__title').allTextContents();
ok('AniList подхватывает, когда Jikan лежит', fbTitles.some(t=>t.includes('Black Clover')), fbTitles.join(' | '));
ok('про сбой не сообщаем, раз запасная база ответила',
   await page.locator('#search-status').isHidden(), await page.locator('#search-status').textContent());

// ---- 19. обе аниме-базы лежат -> внятная ошибка ----
await page.unroute('**/graphql.anilist.co/**');
await page.route('**/graphql.anilist.co/**', r => r.fulfill({ status:503, body:'{}' }));
await page.locator('#search-input').fill('черный клевер');
await page.waitForTimeout(2500);
const bothDown = await page.locator('#search-status').textContent();
ok('обе базы легли — сказано какая', /аниме-база/i.test(bothDown||''), bothDown||'пусто');

// ---- 20. подсказка про ключ TMDB на бедной выдаче ----
ok('подсказка про ключ показана', !(await page.locator('#search-tip').isHidden()));

// ---- 21. TMDB: японская анимация распознаётся как аниме ----
await page.evaluate(() => localStorage.setItem('collectmovie:prefs', JSON.stringify({ tmdbKey:'K', lang:'ru-RU' })));
await page.reload({ waitUntil:'networkidle' });
await page.route('**/api.themoviedb.org/3/genre/**', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ genres:[{id:16,name:'Мультфильм'}] })}));
await page.route('**/api.themoviedb.org/3/search/tv**', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ results:[{ id:1, name:'Чёрный клевер', original_name:'ブラッククローバー',
    first_air_date:'2017-10-03', poster_path:null, overview:'Аста и Юно.',
    genre_ids:[16], original_language:'ja', popularity:90 }]})}));
await page.route('**/api.themoviedb.org/3/search/movie**', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ results:[] })}));
await page.locator('.tab[data-goto="search"]').click();
await page.locator('#search-input').fill('чёрный клевер');
await page.waitForSelector('#search-list .item', { timeout: 15000 });
const tmdbAnime = await page.locator('#search-list .item').first().innerText();
ok('TMDB: японская анимация помечена как аниме', /Аниме/.test(tmdbAnime), tmdbAnime.replace(/\n/g,' / '));
ok('русское название из TMDB', /Чёрный клевер/.test(tmdbAnime));
ok('подсказка про ключ скрыта, раз ключ есть', await page.locator('#search-tip').isHidden());

// ---- 22. вкладка «Аниме» с ключом отдаёт только аниме ----
await page.locator('#search-type-chips .chip[data-type="anime"]').click();
await page.waitForTimeout(2000);
const animeOnly = await page.locator('#search-list .item .badge--anime').count();
const animeTotal = await page.locator('#search-list .item').count();
ok('во вкладке «Аниме» только аниме', animeTotal > 0 && animeOnly === animeTotal,
   `аниме ${animeOnly} из ${animeTotal}`);

} catch (err) {
  console.log('\n!!! ТЕСТ УПАЛ: ' + err.message.split('\n')[0]);
  try {
    await page.screenshot({ path: 'tests/fail.png' });
    console.log('состояние страницы:', JSON.stringify(await page.evaluate(() => ({
      hash: location.hash,
      libCount: document.querySelector('#lib-count')?.textContent,
      libItems: document.querySelectorAll('#lib-list .item').length,
      libVisible: !document.querySelector('#screen-library').hidden,
      lsItems: (() => { try { return JSON.parse(localStorage.getItem('collectmovie:v1')||'{"items":[]}').items.length; } catch { return 'err'; } })(),
      emptyShown: !document.querySelector('#lib-empty').hidden,
    }))));
  } catch {}
}
await browser.close();

console.log('\n=== РЕЗУЛЬТАТЫ ===');
for (const [s,n,e] of checks) console.log(`${s==='PASS'?'  ok':'FAIL'}  ${n}${e?'   ['+e+']':''}`);
const failed = checks.filter(c=>c[0]==='FAIL').length;
const jsErrs = errors.filter(e=>typeof e==='string' && (e.startsWith('console:')||e.startsWith('pageerror:')));
console.log(`\nПройдено ${checks.length-failed}/${checks.length}`);
if (jsErrs.length) { console.log('\nОшибки JS:'); jsErrs.forEach(e=>console.log('  '+e)); }
process.exit(failed || jsErrs.length ? 1 : 0);
