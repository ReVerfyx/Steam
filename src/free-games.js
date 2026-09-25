'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {readJSON, writePrivate} = require('./core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function parsePage(data) {
  if (data.success != 1 || typeof data.results_html !== 'string' || !Number.isInteger(Number(data.total_count))) throw new Error('Неожиданный ответ каталога Steam.');
  const rows = [...data.results_html.matchAll(/<a\b[^>]*class="[^"]*search_result_row[^"]*"[\s\S]*?<\/a>/g)];
  // href precedes class in real Steam HTML; the full opening tag is included above.
  const apps = [];
  for (const row of rows) {
    const id = row[0].match(/data-ds-appid="(\d+)"/);
    if (!id || Number(id[1]) === 480) continue;
    const title = row[0].match(/<span class="title">([\s\S]*?)<\/span>/);
    apps.push({appid:Number(id[1]), name:(title?.[1] || id[1]).replace(/<[^>]+>/g,'')});
  }
  return {apps, rows:rows.length, total:Number(data.total_count)};
}
async function buildCatalog(root, fetcher = fetch, pause = wait) {
  const file = path.join(root,'data','free-catalog.json');
  let state = fs.existsSync(file) ? readJSON(file) : {start:0, apps:[], complete:false};
  if (state.complete && Date.now() - Date.parse(state.updatedAt) < 86400000) return state;
  if (state.complete) state = {start:0, apps:[], complete:false};
  const ids = new Set(state.apps.map(a => a.appid));
  while (!state.complete) {
    const url = new URL('https://store.steampowered.com/search/results/');
    for (const [k,v] of Object.entries({start:state.start,count:50,maxprice:'free',category1:998,infinite:1,json:1,l:'english',sort_by:'Name_ASC'})) url.searchParams.set(k,v);
    const res = await fetcher(url, {signal:AbortSignal.timeout(30000)});
    if (!res.ok) throw new Error(`Каталог Steam: HTTP ${res.status}. Прогресс сохранён; повтори позже.`);
    const page = parsePage(await res.json());
    if (!page.rows && state.start < page.total) throw new Error('Steam вернул пустую страницу раньше конца каталога. Повтори позже.');
    let added = 0;
    for (const app of page.apps) if (!ids.has(app.appid)) {ids.add(app.appid); state.apps.push(app); added++;}
    if (page.rows && !added && state.start > 0) throw new Error('Каталог повторил страницу; остановлено, чтобы не зациклить запросы.');
    state.start += page.rows;
    state.total = page.total;
    state.complete = state.start >= page.total;
    state.updatedAt = new Date().toISOString();
    writePrivate(file,state);
    console.log(`Каталог: просмотрено ${state.start}/${state.total}, найдено ${state.apps.length} приложений.`);
    if (!state.complete) await pause(2000);
  }
  return state;
}
function createClaimer(client, root, dataDir, report, notifyLimit) {
  const file = path.join(dataDir,'free-progress.json');
  const state = fs.existsSync(file) ? readJSON(file) : {done:{}};
  let busy = false;
  return async function tick() {
    if (busy || !client.steamID) return;
    busy = true;
    try {
      const catalog = readJSON(path.join(root,'data','free-catalog.json'));
      const app = catalog.apps.find(a => a.appid !== 480 && !state.done[a.appid]);
      if (!app) return;
      try {
        const result = await client.requestFreeLicense([app.appid]);
        const granted = result.grantedAppIds.includes(app.appid) || result.grantedPackageIds.length > 0;
        state.done[app.appid] = {result:granted ? 'granted' : 'no-new-license', at:new Date().toISOString()};
        writePrivate(file,state);
        report(`Бесплатная лицензия ${app.appid}: ${granted ? 'получена' : 'новая лицензия не выдана (возможно, уже есть)'}.`);
      } catch (err) {
        if (err.eresult === 84 || err.eresult === 25) { notifyLimit(); return; }
        // Permanent refusals are recorded; network/auth errors never consume a queue item.
        if ([8,9,15,24].includes(err.eresult)) {
          state.done[app.appid] = {result:'unavailable', code:err.eresult, at:new Date().toISOString()};
          writePrivate(file,state);
        }
        report(`Лицензия ${app.appid}: ошибка ${Number.isInteger(err.eresult) ? err.eresult : 'сети'}, платёж не выполнялся.`);
      }
    } finally {busy = false;}
  };
}
module.exports = {parsePage, buildCatalog, createClaimer};
