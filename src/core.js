'use strict';
const fs = require('node:fs');
const path = require('node:path');

function parseGames(input) {
  const parts = Array.isArray(input) ? input : String(input).trim().split(/[\s,]+/);
  if (!parts.length || parts.some(x => !/^\d+$/.test(String(x)))) {
    throw new Error('Укажи числовые AppID через запятую, например: 570, 730.');
  }
  const games = [...new Set(parts.map(Number))];
  if (games.length > 32 || games.some(x => !Number.isSafeInteger(x) || x < 1 || x > 4294967295)) {
    throw new Error('Нужно от 1 до 32 корректных AppID.');
  }
  return games;
}
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// State changes are idempotent: gamesPlayed itself can emit playingState.
class IdleController {
  constructor(client, games, report, now = Date.now) {
    this.client = client;
    this.games = games;
    this.report = report;
    this.now = now;
    this.online = false;
    this.blocked = false;
    this.active = false;
    this.since = null;
    this.elapsed = 0;
  }
  setGames(games) {
    if (JSON.stringify(games) === JSON.stringify(this.games)) return;
    this.games = games;
    this.elapsed = 0;
    this.since = this.active ? this.now() : null;
    if (this.active && games.length) this.client.gamesPlayed(games);
    else if (this.active) this.client.gamesPlayed([]);
    this.sync();
  }
  connect(blocked = false) {
    this.online = true;
    this.blocked = blocked;
    this.sync();
  }
  playing(blocked) { this.blocked = blocked; this.sync(); }
  disconnect() { this.online = false; this.sync(); }
  sync() {
    const next = this.online && !this.blocked && this.games.length > 0;
    if (next !== this.active) {
      if (this.active) this.elapsed += this.now() - this.since;
      this.active = next;
      this.since = next ? this.now() : null;
      // Do not claim a playing session while the user is playing elsewhere.
      if (next) this.client.gamesPlayed(this.games);
    }
    this.report(this.snapshot());
  }
  snapshot() {
    return {
      state: !this.online ? 'disconnected' : this.blocked ? 'paused' : !this.games.length ? 'waiting' : 'idling',
      games: this.games,
      estimatedSecondsPerGame: Math.floor((this.elapsed + (this.active ? this.now() - this.since : 0)) / 1000),
      updatedAt: new Date(this.now()).toISOString()
    };
  }
}
module.exports = {parseGames, writePrivate, readJSON, IdleController};
