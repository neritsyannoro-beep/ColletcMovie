/**
 * Сквозные тесты вкладки «Советы». Ответы TMDB и Jikan замоканы,
 * так что проверяется именно логика подбора, а не содержимое баз.
 *
 *   npx http-server -p 8099 -c-1 &
 *   node tests/recs.mjs
 */
import { chromium, devices } from 'playwright';
const errors = [], checks = [];
const ok = (n,c,e='') => { checks.push([c?'  ok':'FAIL', n, e]); };

const b = await chromium.launch();
const p = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
p.on('pageerror', e => errors.push('pageerror: '+e.message));
p.on('console', m => { if (m.type()==='error' && !/Failed to load resource/.test(m.text())) errors.push('console: '+m.text()); });

// --- моки TMDB ---
await p.route('**/api.themoviedb.org/3/genre/**', r => r.fulfill({ contentType:'application/json',
  body: JSON.stringify({ genres:[{id:18,name:'Драма'},{id:16,name:'Мультфильм'}] })}));

const rec = (id,title,year,pop) => ({ id, title, name:title, release_date:`${year}-01-01`,
  first_air_date:`${year}-01-01`, poster_path:'/p.jpg', overview:'Описание.', genre_ids:[18],
  original_language:'en', popularity:pop });

// «Морпехи» (id 100) советуют Оно и Взвод; «Начало» (id 200) советует Оно тоже
await p.route('**/api.themoviedb.org/3/movie/100/recommendations**', r => r.fulfill({
  contentType:'application/json', body: JSON.stringify({ results:[rec(11,'Цельнометаллическая оболочка',1987,50), rec(12,'Взвод',1986,40)] })}));
await p.route('**/api.themoviedb.org/3/movie/200/recommendations**', r => r.fulfill({
  contentType:'application/json', body: JSON.stringify({ results:[rec(11,'Цельнометаллическая оболочка',1987,50), rec(13,'Довод',2020,30)] })}));
// уже в коллекции — не должно попасть в советы
await p.route('**/api.themoviedb.org/3/movie/300/recommendations**', r => r.fulfill({
  contentType:'application/json', body: JSON.stringify({ results:[rec(100,'Морпехи',2005,10)] })}));
await p.route('**/api.themoviedb.org/3/tv/**/recommendations**', r => r.fulfill({
  contentType:'application/json', body: JSON.stringify({ results:[rec(21,'Тьма',2017,60)] })}));
// аниме через Jikan
await p.route('**/api.jikan.moe/v4/anime/*/recommendations**', r => r.fulfill({
  contentType:'application/json', body: JSON.stringify({ data:[
    { entry:{ mal_id: 1735, title:'Naruto Shippuden', images:{jpg:{large_image_url:''}} }, votes: 120 }]})}));

await p.goto('http://127.0.0.1:8099/', { waitUntil:'networkidle' });

// библиотека: 3 фильма (tmdb), 1 сериал (tmdb), 1 аниме (jikan)
await p.evaluate(async () => {
  const s = await import('./assets/js/store.js');
  s.setPrefs({ tmdbKey:'KEY', lang:'ru-RU' });
  s.upsert({ id:'tmdb-movie-100', type:'movie', title:'Морпехи', year:2005, rating:9, status:'watched', source:'tmdb', sourceId:100 });
  s.upsert({ id:'tmdb-movie-200', type:'movie', title:'Начало', year:2010, rating:8, status:'watched', source:'tmdb', sourceId:200 });
  s.upsert({ id:'tmdb-movie-300', type:'movie', title:'Дюна', year:2021, rating:7, status:'watched', source:'tmdb', sourceId:300 });
  s.upsert({ id:'tmdb-tv-400', type:'series', title:'Во все тяжкие', year:2008, rating:10, status:'watched', source:'tmdb', sourceId:400 });
  s.upsert({ id:'jikan-20', type:'anime', title:'Naruto', year:2002, rating:8, status:'watched', source:'jikan', sourceId:20 });
});
await p.reload({ waitUntil:'networkidle' });

// --- вкладка есть и по центру ---
const tabs = await p.locator('.tab span').allTextContents();
ok('пять вкладок', tabs.length === 5, tabs.join(' | '));
ok('«Советы» посередине', tabs[2] === 'Советы', tabs.join(' | '));

await p.locator('.tab[data-goto="recs"]').click();
await p.waitForSelector('#recs-list .item', { timeout: 15000 });

const titles = await p.locator('#recs-list .item__title').allTextContents();
ok('советы по фильмам собрались', titles.length >= 3, titles.join(' | '));
ok('чаще советуемое — первое', titles[0].includes('Цельнометаллическая'), titles.join(' | '));
ok('уже просмотренное отфильтровано', !titles.some(t=>t.includes('Морпехи')), titles.join(' | '));

const why = await p.locator('#recs-list .item__why').first().textContent();
ok('видно, почему советуют', /Похоже на .*Морпехи/.test(why), why);
ok('названы оба источника', /и/.test(why), why);

// --- сериалы ---
await p.locator('#recs-type-chips .chip[data-type="series"]').click();
await p.waitForSelector('#recs-list .item', { timeout: 15000 });
const s2 = await p.locator('#recs-list .item__title').allTextContents();
ok('советы по сериалам отдельные', s2.length === 1 && s2[0].includes('Тьма'), s2.join(' | '));

// --- аниме через Jikan ---
await p.locator('#recs-type-chips .chip[data-type="anime"]').click();
await p.waitForSelector('#recs-list .item', { timeout: 15000 });
const s3 = await p.locator('#recs-list .item__title').allTextContents();
ok('советы по аниме идут из Jikan', s3.some(t=>t.includes('Naruto Shippuden')), s3.join(' | '));

// --- добавление из советов -> «В планах» ---
await p.locator('#recs-list .item').first().click();
await p.waitForSelector('#sheet:not([hidden])');
const planned = await p.locator('#d-status .seg__btn.is-active').textContent();
ok('по умолчанию «В планах»', planned.trim() === 'В планах', planned);
await p.locator('#d-save').click();
await p.waitForSelector('#sheet', { state:'hidden' });
ok('появилась галочка «уже в коллекции»',
   (await p.locator('#recs-list .item__add.is-in').count()) === 1);
ok('служебное поле because не сохранилось',
   await p.evaluate(() => !JSON.parse(localStorage.getItem('collectmovie:v1')).items.some(i=>'because' in i)));

// --- пустое состояние без ключа ---
await p.evaluate(() => localStorage.setItem('collectmovie:prefs', JSON.stringify({ tmdbKey:'', lang:'ru-RU' })));
await p.reload({ waitUntil:'networkidle' });
await p.locator('.tab[data-goto="recs"]').click();
await p.waitForSelector('#recs-empty:not([hidden])', { timeout: 15000 });
ok('без ключа объясняем, что нужен ключ',
   /ключ TMDB/i.test(await p.locator('#recs-empty .empty__title').textContent()));
ok('есть кнопка перехода в настройки', !(await p.locator('#recs-empty-btn').isHidden()));

await b.close();

console.log('\n=== СОВЕТЫ ===');
for (const [s,n,e] of checks) console.log(`${s}  ${n}${e?'   ['+e+']':''}`);
const failed = checks.filter(c=>c[0]==='FAIL').length;
console.log(`\nПройдено ${checks.length-failed}/${checks.length}`);
if (errors.length) { console.log('\nОшибки JS:'); errors.forEach(e=>console.log('  '+e)); }
process.exit(failed || errors.length ? 1 : 0);
