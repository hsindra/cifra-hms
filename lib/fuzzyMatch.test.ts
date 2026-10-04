import { test } from 'node:test';
import assert from 'node:assert/strict';
import { songMatchScore, MATCH_THRESHOLD } from './fuzzyMatch.ts';

test('scores a full title+artist match at 1', () => {
  assert.equal(songMatchScore('só tu és santo morada', 'Só Tu És Santo', 'MORADA'), 1);
});

test('matches on partial/prefix typing (typeahead case)', () => {
  const score = songMatchScore('so tu san', 'Só Tu És Santo', 'MORADA');
  assert.ok(score >= MATCH_THRESHOLD, `expected >= ${MATCH_THRESHOLD}, got ${score}`);
});

test('scores unrelated query low', () => {
  const score = songMatchScore('águas purificadoras', 'Só Tu És Santo', 'MORADA');
  assert.ok(score < MATCH_THRESHOLD, `expected < ${MATCH_THRESHOLD}, got ${score}`);
});

test('empty query scores 0', () => {
  assert.equal(songMatchScore('', 'Só Tu És Santo', 'MORADA'), 0);
});

test('short words and stopwords do not make unrelated songs match', () => {
  for (const [title, artist] of [
    ['Nada Além do Sangue / Alvo Mais Que a Neve (Pot-Pourri)', 'Fernandinho'],
    ['Tudo é Teu', 'Drops INA'],
    ['Tudo é p tua glória', ''],
    ['É Ele', ''],
  ]) {
    const score = songMatchScore('Geração que danca', title, artist);
    assert.ok(score < MATCH_THRESHOLD, `${title}: expected < ${MATCH_THRESHOLD}, got ${score}`);
  }
});

test('matches the right song despite stopwords in the query', () => {
  assert.equal(songMatchScore('Geração que danca', 'Geração Que Dança', 'Ministério Zoe'), 1);
});
