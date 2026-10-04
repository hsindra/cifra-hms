import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chordToNashville,
  nashvilleToChord,
  isMinorKey,
  relativeMajorKey,
  InvalidKeyError,
  inferKeyFromChords,
} from './transpose.ts';

test('converts diatonic chords in a major key', () => {
  assert.equal(chordToNashville('C', 'C'), '1');
  assert.equal(chordToNashville('Dm', 'C'), '2m');
  assert.equal(chordToNashville('F', 'C'), '4');
  assert.equal(chordToNashville('G', 'C'), '5');
  assert.equal(chordToNashville('Am', 'C'), '6m');
});

test('converts diatonic chords in a minor key, keeping quality as-is', () => {
  assert.equal(chordToNashville('Am', 'Am'), '1m');
  assert.equal(chordToNashville('Dm', 'Am'), '4m');
  assert.equal(chordToNashville('Em', 'Am'), '5m');
  assert.equal(chordToNashville('E', 'Am'), '5'); // harmonic-minor V (major), common in worship songs
});

test('marks borrowed/chromatic chords with flat-of-upper-degree accidentals', () => {
  assert.equal(chordToNashville('C', 'Am'), 'b3');
  assert.equal(chordToNashville('F', 'Am'), 'b6');
  assert.equal(chordToNashville('G', 'Am'), 'b7');
});

test('preserves extensions and complex suffixes', () => {
  assert.equal(chordToNashville('Cmaj7', 'C'), '1maj7');
  assert.equal(chordToNashville('G7', 'C'), '57');
  assert.equal(chordToNashville('Dm7', 'C'), '2m7');
  assert.equal(chordToNashville('Csus4', 'C'), '1sus4');
  assert.equal(chordToNashville('Cadd9', 'C'), '1add9');
});

test('converts slash-bass chords, transposing both root and bass', () => {
  assert.equal(chordToNashville('G/B', 'C'), '5/7');
  assert.equal(chordToNashville('C/E', 'C'), '1/3');
  assert.equal(chordToNashville('D/F#', 'C'), '2/b5');
});

test('handles keys with sharps and flats', () => {
  assert.equal(chordToNashville('D', 'D'), '1');
  assert.equal(chordToNashville('Bm', 'D'), '6m');
  assert.equal(chordToNashville('Bb', 'Bb'), '1');
  assert.equal(chordToNashville('Eb', 'Bb'), '4');
  assert.equal(chordToNashville('F', 'Bb'), '5');
});

test('passes through tokens that are not chords (e.g. N.C.)', () => {
  assert.equal(chordToNashville('N.C.', 'C'), 'N.C.');
});

test('nashvilleToChord is the inverse of chordToNashville', () => {
  assert.equal(nashvilleToChord('1', 'C'), 'C');
  assert.equal(nashvilleToChord('2m', 'C'), 'Dm');
  assert.equal(nashvilleToChord('57', 'C'), 'G7');
  assert.equal(nashvilleToChord('b7', 'Am'), 'G');
  assert.equal(nashvilleToChord('5/7', 'C'), 'G/B');
});

test('transposes a degree progression to a different key by reusing the target tonic', () => {
  // I-V-vi-IV in C -> same degrees rendered in the key of G
  const degrees = ['1', '5', '6m', '4'];
  const inG = degrees.map((d) => nashvilleToChord(d, 'G'));
  assert.deepEqual(inG, ['G', 'D', 'Em', 'C']);
});

test('round-trips chord -> nashville -> chord for a variety of chords', () => {
  const key = 'D';
  for (const chord of ['D', 'Em', 'F#m', 'G', 'A7', 'Bm', 'C#m7b5', 'D/F#', 'G/A']) {
    const back = nashvilleToChord(chordToNashville(chord, key), key);
    assert.equal(back, chord, `${chord} should round-trip through key ${key}`);
  }
});

test('throws InvalidKeyError for an unrecognized key', () => {
  assert.throws(() => chordToNashville('C', 'H'), InvalidKeyError);
  assert.throws(() => nashvilleToChord('1', 'Foo'), InvalidKeyError);
});

test('isMinorKey distinguishes minor keys from major ones', () => {
  assert.equal(isMinorKey('Dm'), true);
  assert.equal(isMinorKey('F#m'), true);
  assert.equal(isMinorKey('Bbm'), true);
  assert.equal(isMinorKey('D'), false);
  assert.equal(isMinorKey('F#'), false);
});

test('relativeMajorKey computes the relative major of a minor key', () => {
  assert.equal(relativeMajorKey('Dm'), 'F');
  assert.equal(relativeMajorKey('Am'), 'C');
  assert.equal(relativeMajorKey('C#m'), 'E');
  assert.equal(relativeMajorKey('Bm'), 'D');
  assert.equal(relativeMajorKey('D#m'), 'F#');
});

test('a song fetched in a minor key reads its tonic as a borrowed degree off the relative major', () => {
  // Dm's relative major is F: the Dm tonic chord becomes "6m" (not "1m"),
  // matching how the disclaimer explains it ("apresentada em F como grau 1").
  const major = relativeMajorKey('Dm');
  assert.equal(chordToNashville('Dm', major), '6m');
  assert.equal(chordToNashville('F', major), '1');
  assert.equal(chordToNashville('C', major), '5');
  assert.equal(chordToNashville('Bb', major), '4');
});

test('infers the key from chords when the page has none', () => {
  assert.equal(inferKeyFromChords(['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'G']), 'G');
  assert.equal(inferKeyFromChords(['A', 'F#m', 'D', 'A', 'Bm', 'A', 'D', 'E', 'A']), 'A');
  assert.equal(inferKeyFromChords(['Bb', 'F', 'Gm', 'Eb', 'Bb', 'F/A', 'Eb']), 'Bb');
  assert.equal(inferKeyFromChords(['C#', 'G#', 'A#m', 'F#', 'C#']), 'C#');
  assert.equal(inferKeyFromChords([]), undefined);
});

test('infers A (not D) for a worship song in A using G and Em7 (Estamos de Pé)', () => {
  const verse = ['A', 'F#m', 'D', 'A', 'F#m', 'D2', 'A'];
  const chorus = ['A4', 'A', 'E6', 'E', 'Bm', 'A/C#', 'D2', 'A4', 'A', 'E6', 'E', 'G', 'D', 'A'];
  const bridge = ['Em7', 'G', 'D2', 'A', 'Em7', 'G', 'D', 'A', 'Em7', 'G', 'D'];
  assert.equal(inferKeyFromChords([...verse, ...chorus, ...verse, ...chorus, ...bridge, ...bridge, ...chorus, ...bridge]), 'A');
});

test('still infers keys whose chord set overlaps a neighbor key', () => {
  assert.equal(inferKeyFromChords(['D', 'G', 'A', 'Bm', 'G', 'D', 'A', 'D']), 'D');
  assert.equal(inferKeyFromChords(['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'C']), 'C');
  assert.equal(inferKeyFromChords(['G', 'C', 'D', 'Em', 'C', 'G', 'D', 'G']), 'G');
  assert.equal(inferKeyFromChords(['E', 'B', 'C#m', 'A', 'E', 'B', 'A', 'E']), 'E');
});
