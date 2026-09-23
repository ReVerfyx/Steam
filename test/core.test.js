'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseGames, writePrivate, readJSON, IdleController} = require('../src/core');

test('AppID validation prevents invalid protocol input', () => {
  assert.deepEqual(parseGames('570, 730,570'), [570,730]);
  for (const value of ['', '0', '-1', '570,no', '1.5', '4294967296', Array.from({length:33}, (_,i) => i+1)]) {
    assert.throws(() => parseGames(value));
  }
});
test('Pause, disconnection and reconnection exclude inactive time; no recursive gamesPlayed', () => {
  let now = 0, controller;
  const calls = [];
  const client = {gamesPlayed(games) { calls.push(games); controller.playing(false); }};
  controller = new IdleController(client, [570,730], () => {}, () => now);
  controller.connect();
  now = 10000;
  controller.playing(true);
  now = 50000;
  assert.equal(controller.snapshot().estimatedSecondsPerGame, 10);
  controller.playing(false);
  now = 55000;
  controller.disconnect();
  now = 100000;
  assert.equal(controller.snapshot().estimatedSecondsPerGame, 15);
  controller.connect();
  now = 105000;
  assert.equal(controller.snapshot().estimatedSecondsPerGame, 20);
  assert.equal(calls.length, 3);
});
test('An occupied Steam account is not claimed on login', () => {
  const calls = [];
  const controller = new IdleController({gamesPlayed: games => calls.push(games)}, [570], () => {});
  controller.connect(true);
  assert.equal(controller.snapshot().state, 'paused');
  assert.equal(calls.length, 0);
  controller.playing(false);
  assert.equal(calls.length, 1);
});
test('Session writes remain private and replace old contents atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-hours-test-'));
  try {
    const file = path.join(dir, 'session.json');
    writePrivate(file, {token:'test-only'});
    writePrivate(file, {token:'rotated-test'});
    assert.equal(readJSON(file).token, 'rotated-test');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(file + '.tmp'), false);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
