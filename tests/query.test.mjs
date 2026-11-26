import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.MMM_DATA_DIR = `${process.env.TMPDIR || '/tmp'}/mmm-test-${process.pid}`;
const { compile, sorter } = await import('../server/src/library/query.js');

const rows = [
  { id: 1, title: 'Intro', artist: 'Nujabes', duration: 95, filename: '01 Intro.mp3', genre: ['Jazz'], size: 3e6, added: Date.now() - 2 * 86400e3, custom: { MOOD: 'chill' } },
  { id: 2, title: 'Aruarian Dance', artist: 'Nujabes', duration: 245, filename: 'Aruarian Dance (remix).flac', genre: ['Hip-Hop', 'Jazz'], lossless: true, size: 4e7, added: Date.now() - 90 * 86400e3 },
  { id: 3, title: 'Get Lucky', artist: 'Daft Punk / Pharrell Williams', duration: 248, filename: 'get lucky.mp3', genre: ['Disco'], year: 2013, size: 9e6, added: Date.now() },
];
const ids = (q) => rows.filter(compile(q).test).map((r) => r.id);

test('words search title, artist and file name', () => assert.deepEqual(ids('nujabes'), [1, 2]));
test('field contains / exact', () => {
  assert.deepEqual(ids('artist:pharrell'), [3]);
  assert.deepEqual(ids('genre=jazz'), [1, 2]);
});
test('wildcards', () => assert.deepEqual(ids('filename:*remix*'), [2]));
test('regex', () => assert.deepEqual(ids('title~/^intro$/i'), [1]));
test('lengths, sizes, ranges', () => {
  assert.deepEqual(ids('duration>3:00'), [2, 3]);
  assert.deepEqual(ids('duration:1m..2m'), [1]);
  assert.deepEqual(ids('size>10MB'), [2]);
  assert.deepEqual(ids('year:2010..2015'), [3]);
});
test('relative dates', () => assert.deepEqual(ids('added:7d'), [1, 3]));
test('not, or, groups', () => {
  assert.deepEqual(ids('-genre:jazz'), [3]);
  assert.deepEqual(ids('(artist:daft OR is:lossless) dur>200'), [2, 3]);
  assert.deepEqual(ids('NOT has:lossless'), [1, 3]);
});
test('custom tags', () => assert.deepEqual(ids('tag.MOOD:chill'), [1]));
test('empty fields', () => assert.deepEqual(ids('missing:year'), [1, 2]));
test('sort in the query', () => {
  const { sort } = compile('sort:-duration');
  assert.deepEqual(rows.slice().sort(sorter(sort)).map((r) => r.id), [3, 2, 1]);
});
