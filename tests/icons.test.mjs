// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { ICONS, ICON_BY_EXERCISE, exerciseIconSrc } from '../js/exercise-icons.js';

const root = new URL('../', import.meta.url);
const sw = readFileSync(new URL('sw.js', root), 'utf8');

test('every mapped exercise points to a known icon', () => {
  for (const [id, key] of Object.entries(ICON_BY_EXERCISE)) assert.ok(ICONS.includes(key), id + ' -> ' + key);
});

test('every icon has a 120 x 120 PNG and is saved for offline use', () => {
  for (const key of ICONS) {
    const file = new URL('icons/exercises/' + key + '.png', root);
    assert.ok(existsSync(file), key + '.png is missing');
    const png = readFileSync(file);
    assert.equal(png.readUInt32BE(16), 120, key + ' width');
    assert.equal(png.readUInt32BE(20), 120, key + ' height');
    assert.ok(sw.includes("'./icons/exercises/" + key + ".png'"), key + ' is not in sw.js FILES');
  }
  const files = readdirSync(new URL('icons/exercises/', root)).filter((f) => f.endsWith('.png'));
  assert.deepEqual(files.map((f) => f.slice(0, -4)).sort(), ICONS.slice().sort());
  assert.ok(sw.includes("'./js/exercise-icons.js'"));
});

test('icon address by exercise id; unknown ids have none', () => {
  assert.equal(exerciseIconSrc('squat'), './icons/exercises/squat.png');
  assert.equal(exerciseIconSrc('incline_bench'), './icons/exercises/decline-bench-press.png');
  assert.equal(exerciseIconSrc('k3j2x9'), null);
  assert.equal(exerciseIconSrc('constructor'), null);
  assert.equal(exerciseIconSrc(undefined), null);
});
