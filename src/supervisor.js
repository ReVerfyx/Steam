'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {fork} = require('node:child_process');
const {readJSON, writePrivate} = require('./core');
const {readyProfiles,profilePaths,excludedFromFree} = require('./profiles');
function supervise(root, options = {}) {
  const launchDelay = options.launchDelay ?? 30000;
  const claimDelay = options.claimDelay ?? 90000;
  const tickDelay = options.tickDelay ?? 1000;
  const ids = readyProfiles(root);
  if (!ids.length) throw new Error('Нет профилей с сессией. Выполни npm run setup и npm run login.');
  const children = new Map(), pending = new Set();
  const globalFile = path.join(root,'data','free-global.json');
  const managerLock = path.join(root,'data','supervisor.pid');
  fs.mkdirSync(path.dirname(managerLock),{recursive:true,mode:0o700});
  try {fs.writeFileSync(managerLock,String(process.pid),{flag:'wx',mode:0o600});}
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(fs.readFileSync(managerLock,'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Повреждён data/supervisor.pid. Проверь процессы.');
    try {process.kill(pid,0);} catch (e) {
      if (e.code !== 'ESRCH') throw e;
      fs.unlinkSync(managerLock); return supervise(root, options);
    }
    throw new Error('Служба уже работает. Не запускай второй экземпляр.');
  }
  process.on('exit',()=> {try {fs.unlinkSync(managerLock);} catch {}});
  let stopping = false, launchAt = 0, round = 0;
  const launchQueue = [...ids];
  const log = s => console.log(`[manager] ${s}`);
  function stop(code=0) {
    if (stopping) return;
    stopping = true;
    clearInterval(clock);
    for (const child of children.values()) child.kill('SIGTERM');
    const forced = setTimeout(()=> {for(const child of children.values()) child.kill('SIGKILL'); process.exit(code);},5000);
    forced.unref();
    if (!children.size) process.exit(code);
    process.exitCode = code;
  }
  function launch(id) {
    const child = fork(path.join(root,'src','cli.js'),['worker',id],{stdio:['ignore','inherit','inherit','ipc']});
    children.set(id,child);
    child.on('message',m => {
      if (m?.type === 'ready') pending.add(id);
      if (m?.type === 'offline') pending.delete(id);
      if (m?.type === 'claim-limit') {
        writePrivate(globalFile,{paused:true,nextAt:Date.now()+3600000});
        log('Steam ограничил получение лицензий. Очередь всех аккаунтов остановлена. Возобновление вручную: npm run free -- all');
      }
      if (m?.type === 'login-limit') {log('RateLimitExceeded при входе. Все новые входы остановлены. Повтори запуск позже.'); stop(78);}
    });
    child.on('error',()=>log(`Не удалось запустить ${id}.`));
    child.on('exit',(code)=> {
      children.delete(id); pending.delete(id);
      log(`${id}: процесс завершён (${code}). Повторного входа в цикле не будет.`);
      if (!stopping && !children.size && !launchQueue.length) stop(78);
    });
  }
  function step() {
    if (stopping) return;
    try {
      if (launchQueue.length && Date.now() >= launchAt) {
        launch(launchQueue.shift()); launchAt = Date.now()+launchDelay;
      }
      const enabled = [...pending].filter(id => {
        const config = readJSON(profilePaths(root,id).config);
        return config.claimFree === true && !excludedFromFree(id, config);
      });
      if (!enabled.length) return;
      const state = fs.existsSync(globalFile) ? readJSON(globalFile) : {nextAt:0,paused:false};
      if (state.paused || Date.now() < state.nextAt) return;
      // One request every 90 seconds across ALL profiles, including after restart.
      writePrivate(globalFile,{paused:false,nextAt:Date.now()+claimDelay});
      const child = children.get(enabled[round++ % enabled.length]);
      if (child?.connected) child.send({type:'claim'},err=> {if(err) log('Профиль отключился до запроса лицензии.');});
    } catch {log('Ошибка настроек/очереди. Остановка, проверь JSON и права файлов.'); stop(78);}
  }
  const clock = setInterval(step,tickDelay);
  process.on('SIGTERM',()=>stop()); process.on('SIGINT',()=>stop());
  log(`Профилей: ${ids.length}. Входы выполняются с интервалом 30 секунд.`);
  step();
}
module.exports = {supervise};
