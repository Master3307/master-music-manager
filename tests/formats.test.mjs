import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.MMM_DATA_DIR = `${process.env.TMPDIR || '/tmp'}/mmm-test-${process.pid}`;
const lyrics = await import('../server/src/lyrics.js');
const { parse: parseScrobbles } = await import('../server/src/scrobbles.js');
const { parseCommand, plan } = await import('../server/src/library/commands.js');

test('LRC and word-synced LRC', () => {
  const p = lyrics.parse('[offset:200]\n[00:01.00]One more time\n[00:03.50]<00:03.50>We are <00:04.00>gonna');
  assert.equal(p.synced, true);
  assert.equal(p.offset, 200);
  assert.equal(p.lines[0].start, 1000);
  assert.equal(p.lines[1].words.length, 2);
  assert.match(lyrics.format(p), /\[00:03\.50\]<00:03\.50>We are/);
});
test('lyric match score prefers the right song', () => {
  const want = { title: 'Shelter', artist: 'Porter Robinson', duration: 219 };
  assert.ok(lyrics.score(want, { title: 'Shelter', artist: 'Porter Robinson & Madeon', duration: 220 }) > lyrics.score(want, { title: 'Shelter (Live)', artist: 'Someone', duration: 400 }));
});
test('scrobble files: Last.fm CSV without header, Spotify, ListenBrainz, Rockbox', () => {
  assert.equal(parseScrobbles('Daft Punk,Discovery,One More Time,01 Jan 2024 10:00').items[0].title, 'One More Time');
  const sp = parseScrobbles(JSON.stringify([{ ts: '2024-01-01T10:00:00Z', ms_played: 200000, master_metadata_track_name: 'A', master_metadata_album_artist_name: 'B' }, { ts: '2024-01-01T10:05:00Z', ms_played: 5000, master_metadata_track_name: 'Skip', master_metadata_album_artist_name: 'B' }]));
  assert.equal(sp.format, 'Spotify streaming history');
  assert.equal(sp.items.length, 1);
  assert.equal(parseScrobbles(JSON.stringify([{ listened_at: 1704103200, track_metadata: { artist_name: 'X', track_name: 'Y' } }])).format, 'ListenBrainz');
  assert.equal(parseScrobbles('#AUDIOSCROBBLER/1.1\n#TZ/UTC\nArt\tAlb\tTitle\t1\t200\tL\t1704103200\t').items[0].ts, 1704103200);
});
test('commands: parse and plan', () => {
  const steps = parseCommand('replace artist " & " " / " ; set genre = "Lo-Fi" where artist:nujabes');
  assert.equal(steps.length, 2);
  assert.equal(steps[1].where, 'artist:nujabes');
  const out = plan([{ id: 1, title: 'a', artist: 'A & B', path: 'x.mp3', ext: 'mp3', filename: 'x.mp3', folder: '.' }], [steps[0].op, { type: 'case', field: 'title', style: 'title' }]);
  assert.deepEqual(out[0].changes.artist, ['A & B', 'A / B']);
  assert.deepEqual(out[0].changes.title, ['a', 'A']);
  const wild = plan([{ id: 1, title: 'Song (Official Video)', path: 'x', ext: 'mp3', filename: 'x', folder: '.' }], [{ type: 'replace', field: 'title', find: ' (*)', replace: '', mode: 'wildcard' }]);
  assert.equal(wild[0].changes.title[1], 'Song');
});
