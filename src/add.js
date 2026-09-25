#!/usr/bin/env node
'use strict';
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {profilePaths} = require('./profiles');
const {readJSON} = require('./core');
function range(count, start = '1') {
  if (!/^\d+$/.test(String(count)) || !/^\d+$/.test(String(start))) throw new Error('Формат: npm run add -- количество [начальный_номер]');
  const n = Number(count), first = Number(start);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100000 || !Number.isSafeInteger(first) || first < 1 || first + n - 1 > 100000) throw new Error('Количество и номера профилей должны быть от 1 до 100000.');
  return {n,first};
}
async function add(root, count, start, execute, pause = ms => new Promise(r=>setTimeout(r,ms))) {
  const {n,first} = range(count,start);
  let attempted = false;
  for (let i = first; i < first+n; i++) {
    const id = `acc${i}`, p = profilePaths(root,id);
    const session = path.join(p.data,'session.json');
    if (fs.existsSync(p.config) && fs.existsSync(session)) {
      const c=readJSON(p.config), s=readJSON(session);
      if (s.accountName === c.accountName && typeof s.refreshToken === 'string' && s.refreshToken) {
        console.log(`${id}: сессия уже сохранена, пропуск.`); continue;
      }
    }
    console.log(`Добавление ${i-first+1}/${n}: ${id}`);
    if (!fs.existsSync(p.config)) await execute('setup',id);
    if (attempted) {console.log('Пауза 30 секунд перед следующим входом.'); await pause(30000);}
    attempted = true;
    await execute('login',id);
  }
  console.log('Готово. Для запуска добавленных профилей: sudo systemctl restart steam-hours');
}
if (require.main === module) {
  const root=path.resolve(__dirname,'..');
  let child, cancelled=false;
  const cancel=()=>{cancelled=true;if(child)child.kill('SIGTERM');else process.exit(130);};
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  const execute=(cmd,id)=>new Promise((resolve,reject)=>{
    if(cancelled) return reject(new Error('Отменено.'));
    child=spawn(process.execPath,[path.join(root,'src','cli.js'),cmd,id],{stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',(code)=>{child=null;code===0&&!cancelled?resolve():reject(new Error(`Остановлено на ${id}. Исправь причину и повтори ту же команду; готовые профили будут пропущены.`));});
  });
  if (!process.stdin.isTTY) {console.error('Запусти команду в терминале SSH.');process.exitCode=78;}
  else add(root,process.argv[2],process.argv[3],execute).catch(err=>{console.error(err.message);process.exitCode=78;});
}
module.exports={range,add};
