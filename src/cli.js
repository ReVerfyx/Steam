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
const dataDir = path.join(root, 'data');
const configFile = path.join(root, 'config.json');
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
  const log = text => console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${text}`);
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
    controller.disconnect();
    if (!quitting) log('Steam-user будет пробовать восстановить соединение.');
  });
  client.on('error', err => {
    // Do not print raw exceptions/objects that may contain session credentials.
    const code = err.eresult;
    log(`Ошибка Steam: ${SteamUser.EResult[code] || 'соединение/авторизация'} (${Number.isInteger(code) ? code : 'без кода'}).`);
    const authErrors = [5, 15, 43, 63, 65, 85, 88];
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
  log('Вход в Steam. Если приложение Steam запросит подтверждение — проверь и подтверди свой вход.');
  client.logOn({...details, logonID: randomInt(1, 2147483647), machineName: 'ReVerfyx Steam Hours'});
}
async function main() {
  const cmd = process.argv[2] || 'start';
  if (cmd === 'setup') {
    lock();
    const accountName = (await ask('Логин Steam (не ник): ')).trim();
    if (!accountName) throw new Error('Логин пуст.');
    const games = parseGames((await ask('AppID игр через запятую [570 — Dota 2]: ')).trim() || '570');
    writePrivate(configFile, {accountName, games});
    console.log('Сохранено. Дальше: npm run login');
  } else if (cmd === 'status') {
    if (!fs.existsSync(statusFile)) { console.log('Нет данных. Запусти npm start.'); return; }
    const status = readJSON(statusFile);
    console.log(JSON.stringify(status, null, 2));
    console.log('Это последний локальный снимок, не подтверждение текущей работы и не счётчик Steam. Проверка службы: systemctl status steam-hours');
  } else if (cmd === 'start' || cmd === 'login') await run(cmd === 'login');
  else throw new Error('Команды: setup, login, start, status.');
}
main().catch(err => {
  console.error(err.code === 'ENOENT' ? 'Нет настройки или файла. Выполни npm run setup, затем npm run login.' : err.message);
  process.exit(78);
});
