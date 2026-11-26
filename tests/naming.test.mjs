import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.MMM_DATA_DIR = `${process.env.TMPDIR || '/tmp'}/mmm-test-${process.pid}`;
const { splitArtists, joinArtists, targetPath, render, safePart } = await import('../server/src/library/naming.js');
const { DEFAULTS } = await import('../server/src/settings.js');
const lib = { ...DEFAULTS.library, keepTogether: ['Simon & Garfunkel', 'Tyler, The Creator'] };
const j = (s) => joinArtists(splitArtists(s, lib), ' / ');

test('splits feat., ft, &, commas and x', () => {
  assert.equal(j('Daft Punk feat. Pharrell Williams'), 'Daft Punk / Pharrell Williams');
  assert.equal(j('A, B & C'), 'A / B / C');
  assert.equal(j('Felix Jaehn ft Robin Schulz'), 'Felix Jaehn / Robin Schulz');
  assert.equal(j('Max x Mix'), 'Max / Mix');
  assert.equal(j('Artist (feat. Guest)'), 'Artist / Guest');
});
test('keeps protected names and words like Xavier', () => {
  assert.equal(j('Simon & Garfunkel x Tyler, The Creator'), 'Simon & Garfunkel / Tyler, The Creator');
  assert.equal(j('Xavier'), 'Xavier');
});
test('default layout is Artist/Album/NN - Title', () => {
  assert.equal(targetPath({ title: 'Get Lucky', artist: 'Daft Punk feat. Pharrell', album: 'Random Access Memories', track: 8, ext: 'flac' }, lib), 'Daft Punk/Random Access Memories/08 - Get Lucky.flac');
  assert.equal(targetPath({ title: 'Single', artist: 'A / B', ext: 'mp3' }, lib), 'A/Single/Single.mp3');
  assert.equal(targetPath({ filename: 'noise.mp3', ext: 'mp3' }, lib, { misc: true }), '!Misc/noise.mp3');
});
test('template features', () => {
  assert.equal(render('{artist:initial}/{?disc>1|disctotal>1:CD{disc}/}{track:3}. {title:upper} [{year|"n/a"}]', { title: 'x', artist: 'Daft Punk', disc: 2, track: 8 }, lib), 'D/CD2/008. X [n/a]');
});
test('safe file names', () => {
  assert.equal(safePart('AC/DC: Back?', 'x'), 'AC-DC_ Back_');
  assert.equal(safePart('  .. ', 'Fallback'), 'Fallback');
  assert.equal(safePart('con', 'x'), '_con');
});
