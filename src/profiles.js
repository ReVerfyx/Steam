'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {readJSON} = require('./core');
function profilePaths(root, id = 'main') {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || id === 'all') throw new Error('Имя профиля: латинские буквы, цифры, _ и -, до 40 символов; all зарезервировано.');
  const base = id === 'main' ? root : path.join(root, 'accounts', id);
  return {config: path.join(base, 'config.json'), data: path.join(base, 'data')};
}
function profiles(root) {
  const ids = fs.existsSync(path.join(root, 'config.json')) ? ['main'] : [];
  const folder = path.join(root, 'accounts');
  if (fs.existsSync(folder)) for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
    if (entry.isDirectory() && entry.name !== 'main' && entry.name !== 'all' && /^[a-zA-Z0-9_-]{1,40}$/.test(entry.name)) {
      if (fs.existsSync(profilePaths(root, entry.name).config)) ids.push(entry.name);
    }
  }
  return ids;
}
function readyProfiles(root) {
  const seen = new Set();
  return profiles(root).filter(id => {
    const p = profilePaths(root,id);
    const c = readJSON(p.config);
    const name = String(c.accountName || '').toLowerCase();
    if (!name || seen.has(name)) throw new Error(`Повтор или пустой логин в профиле ${id}.`);
    seen.add(name);
    return c.enabled !== false && fs.existsSync(path.join(p.data,'session.json'));
  });
}
function excludedFromFree(id, config) {
  return config.freeExcluded === true || [id, config.accountName].some(value => String(value || '').trim().toLowerCase() === 'reverfyx');
}
module.exports = {profilePaths, profiles, readyProfiles, excludedFromFree};
