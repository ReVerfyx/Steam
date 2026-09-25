#!/usr/bin/env node
'use strict';
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {Writable} = require('node:stream');
const {randomInt} = require('node:crypto');
const {parseGames, writePrivate, readJSON, IdleController} = require('./core');
const root = path.resolve(__dirname, '..');
const {profilePaths, profiles, excludedFromFree} = require('./profiles');
const profile = process.argv[3] || 'main';
const paths = profilePaths(root, profile === 'all' ? 'main' : profile);
const dataDir = paths.data;
const configFile = paths.config;
const sessionFile = path.join(dataDir, 'session.json');
const statusFile = path.join(dataDir, 'status.json');
const lockDir = path.join(dataDir, 'instance.lock');
let ownsLock = false;

function ask(label, secret = false) {
  if (!process.stdin.isTTY) return Promise.reject(new Error('Для ввода нужен терминал SSH.'));
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    }});
    const rl = readline.createInterface({input: process.stdin, output, terminal: true});
    rl.on('SIGINT', () => { rl.close(); reject(new Error('Отменено.')); });
    rl.question(label, value => {
      muted = false;
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(value);
    });
    muted = secret;
  });
}
function lock() {
  fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});
  fs.chmodSync(dataDir, 0o700);
  try { fs.mkdirSync(lockDir, {mode: 0o700}); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let pid;
    try { pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')); }
    catch { throw new Error('Есть блокировка экземпляра. Проверь работающие процессы перед удалением data/instance.lock.'); }
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Некорректный PID в data/instance.lock.');
    try { process.kill(pid, 0); }
    catch (e) {
      if (e.code !== 'ESRCH') throw e;
      fs.rmSync(lockDir, {recursive: true});
      return lock();
    }
    throw new Error('Программа уже запущена. Сначала: sudo systemctl stop steam-hours');
  }
  ownsLock = true;
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid), {mode: 0o600});
}
process.on('exit', () => { if (ownsLock) fs.rmSync(lockDir, {recursive: true, force: true}); });

async function run(loginOnly) {
  const config = readJSON(configFile);
  const games = parseGames(config.games);
  if (typeof config.accountName !== 'string' || !config.accountName.trim()) throw new Error('Сначала npm run setup.');
  lock();
  const SteamUser = require('steam-user');
  const client = new SteamUser({
    dataDirectory: dataDir,
    autoRelogin: true,
    renewRefreshTokens: true,
    enablePicsCache: false
  });
  let lastState, timer, watchdog, quitting = false, tokenSaved = false, loggedIn = false;
  const log = text => console.log(`[${profile} ${new Date().toLocaleTimeString('ru-RU')}] ${text}`);
  const notify = type => {if (process.connected) process.send({type});};
  const claim = require('./free-games').createClaimer(client, root, dataDir, log, () => notify('claim-limit'));
  process.on('message', message => {
    if (message?.type === 'claim' && !quitting && loggedIn && !loginOnly) {
      try {
        const current = readJSON(configFile);
        if (current.claimFree && !excludedFromFree(profile, current)) claim().catch(() => log('Не удалось прочитать каталог или прогресс лицензий.'));
      } catch {log('Ошибка настройки: получение лицензий пропущено.');}
    }
  });
  const controller = new IdleController(client, games, status => {
    writePrivate(statusFile, {...status, pid: process.pid});
    if (status.state !== lastState) {
      lastState = status.state;
      log({idling: `Отправлен статус игры: ${games.join(', ')}.`, paused: 'Пауза: ты играешь на другом устройстве.', disconnected: 'Нет соединения со Steam.'}[status.state]);
    }
  });
  function finish(code) {
    if (quitting) return;
    quitting = true;
    clearInterval(timer);
    clearTimeout(watchdog);
    controller.disconnect();
    try { if (client.steamID) { client.gamesPlayed([]); client.logOff(); } } catch {}
    setTimeout(() => process.exit(code), 300);
  }
  function loginDone() {
    if (loginOnly && loggedIn && tokenSaved) {
      log('Вход выполнен. Сессия сохранена локально; пароль не сохранён. Теперь можно включить службу.');
      finish(0);
    }
  }
  client.on('refreshToken', refreshToken => {
    try {
      writePrivate(sessionFile, {accountName: config.accountName, refreshToken});
      tokenSaved = true;
      loginDone();
    } catch { log('Не удалось сохранить сессию. Проверь права на data/.'); finish(78); }
  });
  client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
    if (!process.stdin.isTTY) { log('Нужен Steam Guard: останови службу и выполни npm run login.'); finish(78); return; }
    try {
      if (lastCodeWrong) {
        log('Неверный код. Подожди появления нового кода в приложении (30 секунд).');
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      const code = (await ask(domain ? 'Код Steam Guard из почты: ' : 'Код Steam Guard из приложения: ', true)).trim();
      if (!code) throw new Error('Пустой код.');
      callback(code);
    } catch { finish(78); }
  });
  client.on('loggedOn', () => {
    loggedIn = true;
    clearTimeout(watchdog);
    log('Подключено к Steam.');
    if (!loginOnly) notify('ready');
    if (loginOnly) {
      loginDone();
      if (!quitting) watchdog = setTimeout(() => { log('Steam не выдал токен сессии. Повтори вход.'); finish(78); }, 30000);
      return;
    }
    client.setPersona(SteamUser.EPersonaState.Online);
    controller.connect(Boolean(client.playingState?.blocked));
    if (!timer) timer = setInterval(() => {
      const status = controller.snapshot();
      writePrivate(statusFile, {...status, pid: process.pid});
      log(`Состояние: ${status.state}; локальная оценка за этот запуск: ${(status.estimatedSecondsPerGame / 3600).toFixed(2)} ч/игру. Это не проверенный счётчик Steam.`);
    }, 60000);
  });
  client.on('playingState', blocked => { if (!quitting && !loginOnly) controller.playing(blocked); });
  client.on('disconnected', () => {
    loggedIn = false;
    notify('offline');
    controller.disconnect();
    if (!quitting) log('Steam-user будет пробовать восстановить соединение.');
  });
  client.on('error', err => {
    // Do not print raw exceptions/objects that may contain session credentials.
    const code = err.eresult;
    log(`Ошибка Steam: ${SteamUser.EResult[code] || 'соединение/авторизация'} (${Number.isInteger(code) ? code : 'без кода'}).`);
    const authErrors = [5, 15, 43, 63, 65, 84, 85, 88];
    if (code === 84) {log('Ограничение входов Steam. Не повторяй вход сейчас.'); notify('login-limit');}
    if (authErrors.includes(code)) log('Останови службу и выполни npm run login для повторного входа.');
    finish(authErrors.includes(code) ? 78 : 1);
  });
  process.on('SIGTERM', () => finish(0));
  process.on('SIGINT', () => finish(0));
  let details;
  if (!loginOnly && fs.existsSync(sessionFile)) {
    const session = readJSON(sessionFile);
    if (session.accountName !== config.accountName || typeof session.refreshToken !== 'string' || !session.refreshToken) {
      throw new Error('Сессия не подходит аккаунту. Выполни npm run login.');
    }
    details = {refreshToken: session.refreshToken};
  } else {
    if (!process.stdin.isTTY) throw new Error('Сначала выполни npm run login через SSH.');
    const password = await ask('Пароль Steam (ввод скрыт): ', true);
    if (!password) throw new Error('Пароль пуст.');
    details = {accountName: config.accountName, password};
  }
  watchdog = setTimeout(() => { log('Истекло время входа (5 минут). Попробуй позже.'); finish(1); }, 300000);
  log('Вход в Steam. Эта версия входа использует код Steam Guard из приложения/почты.');
  client.logOn({...details, logonID: randomInt(1, 2147483647), machineName: 'ReVerfyx Steam Hours'});
}
async function main() {
  const cmd = process.argv[2] || 'start';
  if (cmd === 'accounts') {
    for (const id of profiles(root)) {
      const p = profilePaths(root,id); const c = readJSON(p.config);
      console.log(`${id}: ${c.accountName}; игр ${c.games.length}; сессия ${fs.existsSync(path.join(p.data,'session.json')) ? 'есть' : 'нет'}; бесплатные ${excludedFromFree(id,c) ? 'исключён' : c.claimFree ? 'включены' : 'выключены'}`);
    }
  } else if (cmd === 'free-exclude') {
    if (profile === 'all') throw new Error('Укажи конкретный профиль для исключения.');
    const c = readJSON(configFile);
    writePrivate(configFile,{...c,claimFree:false,freeExcluded:true});
    console.log(`${profile}: исключён из получения бесплатных игр, включая free all.`);
  } else if (cmd === 'free' || cmd === 'free-off') {
    const ids = profile === 'all' ? profiles(root) : [profile];
    const configs = ids.map(id => ({id, file:profilePaths(root,id).config, value:readJSON(profilePaths(root,id).config)}));
    if (!configs.length) throw new Error('Сначала добавь аккаунт.');
    if (cmd === 'free' && configs.some(c => !excludedFromFree(c.id,c.value))) await require('./free-games').buildCatalog(root);
    for (const c of configs) {
      const excluded = excludedFromFree(c.id,c.value);
      writePrivate(c.file,{...c.value,claimFree:cmd === 'free' && !excluded});
      if (excluded) console.log(`${c.id}: исключён из получения бесплатных игр.`);
    }
    if (cmd === 'free') {
      const file = path.join(root,'data','free-global.json');
      const state = fs.existsSync(file) ? readJSON(file) : {nextAt:0};
      writePrivate(file,{...state,paused:false});
    }
    console.log(cmd === 'free' ? 'Получение доступных free-to-play лицензий включено. Запусти службу; выбранные игры для часов не меняются.' : 'Получение лицензий выключено.');
  } else if (cmd === 'setup') {
    lock();
    const accountName = (await ask('Логин Steam (не ник): ')).trim();
    if (!accountName) throw new Error('Логин пуст.');
    const previous = fs.existsSync(configFile) ? readJSON(configFile) : {};
    const mainConfig = path.join(root,'config.json');
    const defaults = previous.games || (fs.existsSync(mainConfig) ? readJSON(mainConfig).games : [570]);
    const games = parseGames((await ask(`AppID через запятую [Enter: ${defaults.join(',')}]: `)).trim() || defaults);
    for (const id of profiles(root)) {
      if (id !== profile && String(readJSON(profilePaths(root,id).config).accountName).toLowerCase() === accountName.toLowerCase()) throw new Error('Этот Steam-аккаунт уже есть в другом профиле.');
    }
    writePrivate(configFile, {...previous, accountName, games});
    console.log(`Сохранено. Дальше: npm run login -- ${profile}`);
  } else if (cmd === 'status') {
    if (!fs.existsSync(statusFile)) { console.log('Нет данных. Запусти npm start.'); return; }
    const status = readJSON(statusFile);
    console.log(JSON.stringify(status, null, 2));
    console.log('Это последний локальный снимок, не подтверждение текущей работы и не счётчик Steam. Проверка службы: systemctl status steam-hours');
  } else if (cmd === 'start') require('./supervisor').supervise(root);
  else if (cmd === 'worker' || cmd === 'login') await run(cmd === 'login');
  else throw new Error('Команды: setup [профиль], login [профиль], start, status [профиль], accounts, free [профиль|all], free-off [профиль|all].');
}
main().catch(err => {
  console.error(err.code === 'ENOENT' ? 'Нет настройки или файла. Выполни npm run setup, затем npm run login.' : err.message);
  process.exit(78);
});
