import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chordsOverLyricsToChordPro,
  buildChordPro,
  parseChordProHeader,
  parseChordProBody,
  removeTablature,
  ANNOTATION_NEWLINE,
} from './chordpro.ts';

const sample = `(Intro) E  B  C#m  A

E                B
Tempo perdido, ninguém quer
C#m                    A
saber, mas nós vamos viver

E  B  C#m  A
`;

test('merges chord line into the lyric line at the right column', () => {
  const out = chordsOverLyricsToChordPro(sample);
  assert.match(out, /\[E\]Tempo perdido, ni\[B\]nguém quer/);
  assert.match(out, /\[C#m\]saber, mas nós vamos vi\[A\]ver/);
});

test('renders an instrumental-only chord line as bracketed chords', () => {
  const out = chordsOverLyricsToChordPro(sample);
  assert.match(out, /\[E\] \[B\] \[C#m\] \[A\]/);
});

test('strips Tom/Capotraste metadata lines from the body', () => {
  const withMeta = `Tom: Bm\nCapotraste na 2ª casa\n\nBm\nOla mundo\n`;
  const out = chordsOverLyricsToChordPro(withMeta);
  assert.doesNotMatch(out, /Tom:/);
  assert.doesNotMatch(out, /Capotraste/);
});

test('buildChordPro adds header directives', () => {
  const out = buildChordPro(
    { title: 'Tempo Perdido', artist: 'Legião Urbana', key: 'Bm', capo: '2' },
    sample
  );
  assert.match(out, /\{title: Tempo Perdido\}/);
  assert.match(out, /\{artist: Legião Urbana\}/);
  assert.match(out, /\{key: Bm\}/);
  assert.match(out, /\{capo: 2\}/);
});

test('parseChordProHeader reads directives wherever they are', () => {
  const doc = buildChordPro(
    { title: 'Tempo Perdido', artist: 'Legião Urbana', key: 'Bm', capo: '2' },
    sample
  );
  const header = parseChordProHeader(doc);
  assert.equal(header.title, 'Tempo Perdido');
  assert.equal(header.artist, 'Legião Urbana');
  assert.equal(header.key, 'Bm');
  assert.equal(header.capo, '2');
});

test('buildChordPro/parseChordProHeader round-trip originalMinorKey', () => {
  const doc = buildChordPro(
    { title: 'Deus da Minha Vida', artist: 'Anônimo', key: 'F', originalMinorKey: 'Dm' },
    sample
  );
  assert.match(doc, /\{originalkey: Dm\}/);
  const header = parseChordProHeader(doc);
  assert.equal(header.key, 'F');
  assert.equal(header.originalMinorKey, 'Dm');
});

test('parseChordProHeader leaves originalMinorKey undefined when absent', () => {
  const doc = buildChordPro({ title: 'X', artist: 'Y', key: 'C' }, sample);
  assert.equal(parseChordProHeader(doc).originalMinorKey, undefined);
});

test('parseChordProBody splits chord/lyric chunks and passes through plain lines', () => {
  const body = parseChordProBody('[E]Tempo perdido, ni[B]nguém quer\n\nlinha sem acorde');
  assert.equal(body.length, 3);
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [
      { kind: 'chord', chord: 'E', lyric: 'Tempo perdido, ni' },
      { kind: 'chord', chord: 'B', lyric: 'nguém quer' },
    ],
  });
  assert.deepEqual(body[1], { type: 'blank' });
  assert.deepEqual(body[2], { type: 'text', text: 'linha sem acorde' });
});

test('parseChordProBody handles a chord with no following lyric', () => {
  const body = parseChordProBody('[E] [B] [C#m] [A]');
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [
      { kind: 'chord', chord: 'E', lyric: ' ' },
      { kind: 'chord', chord: 'B', lyric: ' ' },
      { kind: 'chord', chord: 'C#m', lyric: ' ' },
      { kind: 'chord', chord: 'A', lyric: '' },
    ],
  });
});

test('parseChordProBody keeps a {tag} inline without forcing a line break', () => {
  const body = parseChordProBody('{Intro} [1] [%]\n[1] [%] {Verso 1}\n{Refrão}');
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [
      { kind: 'tag', label: 'Intro' },
      { kind: 'chord', chord: null, lyric: ' ' },
      { kind: 'chord', chord: '1', lyric: ' ' },
      { kind: 'chord', chord: '%', lyric: '' },
    ],
  });
  assert.deepEqual(body[1], {
    type: 'chords',
    chunks: [
      { kind: 'chord', chord: '1', lyric: ' ' },
      { kind: 'chord', chord: '%', lyric: ' ' },
      { kind: 'tag', label: 'Verso 1' },
    ],
  });
  assert.deepEqual(body[2], {
    type: 'chords',
    chunks: [{ kind: 'tag', label: 'Refrão' }],
  });
});

test('parseChordProBody joins a lone {tag} line with the chord-only line right after it', () => {
  const body = parseChordProBody('{Verso 1}\n[1] [%] [4] [%]');
  assert.equal(body.length, 1);
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [
      { kind: 'tag', label: 'Verso 1' },
      { kind: 'chord', chord: null, lyric: ' ' },
      { kind: 'chord', chord: '1', lyric: ' ' },
      { kind: 'chord', chord: '%', lyric: ' ' },
      { kind: 'chord', chord: '4', lyric: ' ' },
      { kind: 'chord', chord: '%', lyric: '' },
    ],
  });
});

test('parseChordProBody joins a chord-only line with the {tag} line right after it', () => {
  // A real Cifra Club export puts the chord progression before the section
  // label, the reverse of the case above — must merge either way round.
  const body = parseChordProBody('[1] [%] [4] [%]\n{Verso 1}');
  assert.equal(body.length, 1);
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [
      { kind: 'chord', chord: '1', lyric: ' ' },
      { kind: 'chord', chord: '%', lyric: ' ' },
      { kind: 'chord', chord: '4', lyric: ' ' },
      { kind: 'chord', chord: '%', lyric: '' },
      { kind: 'chord', chord: null, lyric: ' ' },
      { kind: 'tag', label: 'Verso 1' },
    ],
  });
});

test('parseChordProBody leaves a {tag} line alone when the next line has lyrics', () => {
  const body = parseChordProBody('{Verso 1}\n[E]Tempo perdido');
  assert.equal(body.length, 2);
  assert.deepEqual(body[0], { type: 'chords', chunks: [{ kind: 'tag', label: 'Verso 1' }] });
});

test('parseChordProBody leaves a {tag} line alone when a blank line separates it from chords', () => {
  const body = parseChordProBody('{Verso 1}\n\n[1] [%]');
  assert.equal(body.length, 3);
  assert.deepEqual(body[0], { type: 'chords', chunks: [{ kind: 'tag', label: 'Verso 1' }] });
});

test('parseChordProBody keeps a multi-line <...> annotation on one logical line', () => {
  const body = parseChordProBody('<Tom: B capô 4 casa\nposição G>\n[1]Letra');
  assert.equal(body.length, 2);
  assert.deepEqual(body[0], {
    type: 'text',
    text: `<Tom: B capô 4 casa${ANNOTATION_NEWLINE}posição G>`,
  });
});

test('parseChordProBody folds a {tag}[progression] bracket into the tag label', () => {
  const body = parseChordProBody('{Refrão}[ 4 | 2m | 1 | 6m ]');
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [{ kind: 'tag', label: 'Refrão - 4 | 2m | 1 | 6m' }],
  });
});

test('parseChordProBody folds a {tag} [progression] bracket (with a space) too', () => {
  const body = parseChordProBody('{Ponte} [ 47M | 54 | 6m7 | 3m7 ]');
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [{ kind: 'tag', label: 'Ponte - 47M | 54 | 6m7 | 3m7' }],
  });
});

test('parseChordProBody folds a {tag} [progression] bracket separated by a non-breaking space', () => {
  const nbsp = String.fromCharCode(0x00a0);
  const body = parseChordProBody(`{Pré-Refrão}${nbsp}[ 2m | 1/3 | 49 | % ]`);
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [{ kind: 'tag', label: 'Pré-Refrão - 2m | 1/3 | 49 | %' }],
  });
});

test('parseChordProBody leaves a spaced {tag} [chord] [chord] progression alone', () => {
  const body = parseChordProBody('{Intro} [1] [%]');
  assert.deepEqual(body[0], {
    type: 'chords',
    chunks: [
      { kind: 'tag', label: 'Intro' },
      { kind: 'chord', chord: null, lyric: ' ' },
      { kind: 'chord', chord: '1', lyric: ' ' },
      { kind: 'chord', chord: '%', lyric: '' },
    ],
  });
});

test('removeTablature strips an ASCII guitar-tab block', () => {
  const withTab = `Intro:
e|-----------------------------|
B|-----------------------------|
G|--------------2--------------|
D|----0---------2-----0--------|
A|----2---------0-----2--------|
E|----3------------------3-----|

E                B
Tempo perdido, ninguém quer`;
  const out = removeTablature(withTab);
  assert.doesNotMatch(out, /\|-+\|?/);
  assert.match(out, /Intro:/);
  assert.match(out, /Tempo perdido, ninguém quer/);
});

test('removeTablature strips a lone tab line too (e.g. a single-string riff excerpt)', () => {
  const text = 'e|-----0-----2-----|\nE                B\nTempo perdido, ninguém quer';
  const out = removeTablature(text);
  assert.doesNotMatch(out, /\|-+\|?/);
  assert.match(out, /Tempo perdido, ninguém quer/);
});

test('removeTablature recognizes bend/release technique letters (b/r), not just h/p/x', () => {
  const withTab = `[Tab - Solo Intro]
E|-----------------10---------7-------------|
B|-7b8r7---------8------8h10----10-----7----|

E                B
Tempo perdido, ninguém quer`;
  const out = removeTablature(withTab);
  assert.doesNotMatch(out, /\|-+\|?/);
  assert.doesNotMatch(out, /Tab - Solo Intro/);
  assert.match(out, /Tempo perdido, ninguém quer/);
});

test('removeTablature drops an orphaned "[Tab - ...]" label even with no tab lines under it', () => {
  const text = '[Tab - Riff Guitarra]\n\nE                B\nTempo perdido, ninguém quer';
  const out = removeTablature(text);
  assert.doesNotMatch(out, /Tab - Riff Guitarra/);
  assert.match(out, /Tempo perdido, ninguém quer/);
});

test('removeTablature leaves chord/lyric-only text untouched', () => {
  const out = removeTablature(sample);
  assert.equal(out.trim(), sample.trim());
});

test('buildChordPro notes an inferred key in a <> comment right after the source link', () => {
  const out = buildChordPro(
    { title: 'T', artist: 'A', key: 'D', sourceUrl: 'https://www.cifraclub.com.br/a/t/', keyInferred: true },
    'D  A\nla la\n'
  );
  const lines = out.split('\n');
  const i = lines.indexOf('{comment: Fonte - https://www.cifraclub.com.br/a/t/}');
  assert.ok(i >= 0);
  assert.equal(lines[i + 1], '{comment: <Tom D deduzido pelos acordes - o Cifra Club não informava o tom>}');
  assert.ok(!buildChordPro({ title: 'T', artist: 'A', key: 'D' }, 'D\n').includes('deduzido'));
});

test('turns "[Intro] A Em7 G D" into a tag with its progression', () => {
  const out = chordsOverLyricsToChordPro('[Intro] A  Em7  G  D\n');
  assert.equal(out.trim(), '{Intro}[ A | Em7 | G | D ]');
});

test('section tags carry one cycle of the section progression', () => {
  const raw = [
    '[Primeira Parte]',
    'A',
    '  Pressionados',
    'F#m',
    '    Perplexos',
    '                D',
    'Mas não desesperados',
    '         A',
    'Estamos de pé',
    'F#m',
    '    Abatidos',
    '[Sem Acordes]',
    'só letra',
  ].join('\n');
  const out = chordsOverLyricsToChordPro(raw);
  assert.ok(out.startsWith('{Primeira Parte}[ A | F#m | D ]\n'), out);
  assert.ok(out.includes('{Sem Acordes}\n'), out);
});

test('converting to Nashville converts each chord of a "|" progression bracket', async () => {
  const { convertChordProToNashville } = await import('./chordpro.ts');
  assert.equal(
    convertChordProToNashville('{Intro}[ A | Em7 | G | D ]\n[A]la', 'A'),
    '{Intro}[ 1 | 5m7 | b7 | 4 ]\n[1]la'
  );
});

test('flowSections joins each section into one line, keeping alignment spaces', async () => {
  const { flowSections } = await import('./chordpro.ts');
  const body = '{Intro}[ A | D ]\n\n{Verso}\n[A]  Pressionados\n\nMas não desanimados\n[F#m]    Perplexos\n{Refrão}\n[D]Fé\n';
  assert.equal(
    flowSections(body),
    '{Intro}[ A | D ]\n\n{Verso}\n[A]  Pressionados Mas não desanimados [F#m]    Perplexos\n\n{Refrão}\n[D]Fé\n'
  );
});

test('flowSections keeps header directives on their own lines', async () => {
  const { flowSections } = await import('./chordpro.ts');
  assert.equal(
    flowSections('{title: T}\n{key: A}\n\n{Verso}\n[1]la\nlá\n'),
    '{title: T}\n{key: A}\n\n{Verso}\n[1]la lá\n'
  );
});

test('"Intro: D D Bm Bm" becomes an Intro tag with its chords', () => {
  assert.equal(chordsOverLyricsToChordPro('Intro: D D Bm Bm\n').trim(), '{Intro}[ D | D | Bm | Bm ]');
  assert.ok(!chordsOverLyricsToChordPro('Tom: D\n').includes('{'));
  assert.ok(!chordsOverLyricsToChordPro('Refrão: Senhor\n').includes('{'));
});

test('addSectionProgressions (re)writes tag progressions from their sections', async () => {
  const { addSectionProgressions } = await import('./chordpro.ts');
  const src = [
    '{title: T}',
    '{Verso}',
    '[1]A tua [6m]graça [%] nos [4.]faz [4]faz [1]dançar [6m]com',
    '{Refrão}[ 2m | 5 ]',
    '[4]la [5]la',
    '{Intro} [1] [%] [4]',
    '{Ponte}',
    'só letra',
    '{Final}[1]fim com letra',
    '{Fim}',
    '[1]fim',
  ].join('\n');
  assert.equal(
    addSectionProgressions(src),
    [
      '{title: T}',
      '{Verso}[ 1 | 6m | 4 | 1 ]',
      '[1]A tua [6m]graça [%] nos [4.]faz [4]faz [1]dançar [6m]com',
      '{Refrão}[ 4 | 5 ]',
      '[4]la [5]la',
      '{Intro} [1] [%] [4]',
      '{Ponte}',
      'só letra',
      '{Final}[1]fim com letra',
      '{Fim} [1]',
      '[1]fim',
    ].join('\n')
  );
});

test('addSectionProgressions uses the first stanza, up to a blank line, without cycle cutting', async () => {
  const { addSectionProgressions } = await import('./chordpro.ts');
  const src = [
    '{Verso}[ 1 | 6m | 4 ]',
    'A [1]tua graça nos faz dançar',
    'Co[6m]m toda força celebrar',
    'Da[4]nçaremos gratos por [1]teu amor',
    '',
    'A [1]tua gloria nos faz cantar',
    'Po[6m]r toda terra te exaltar',
    'Ca[4]ntaremos glorias a [5]ti, Senhor',
    '',
    '{Pré-refrão}',
    '',
    'É o tr[2m]ansbordar',
    'Por nos [1/3]perdoar',
  ].join('\n');
  const out = addSectionProgressions(src).split('\n');
  assert.equal(out[0], '{Verso}[ 1 | 6m | 4 | 1 ]');
  assert.equal(out[9], '{Pré-refrão}[ 2m | 1/3 ]');
});

test('addSectionProgressions closes the cycle at 4 chords when the stanza is longer', async () => {
  const { addSectionProgressions } = await import('./chordpro.ts');
  const out = addSectionProgressions('{Refrão}\n[1]a [5]b [4.]c [6m]d\n[4]e [1]f [5]g\n');
  assert.equal(out.split('\n')[0], '{Refrão}[ 1 | 5 | 6m | 4 ]');
});

test('recognizes Brazilian/extended chord notation as chords', async () => {
  const { CHORD_TOKEN } = await import('./chordpro.ts');
  for (const c of ['B7M', 'A7M/C#', 'C7M(9)', 'F#m7(b5)', 'E°', 'G7+', 'D4', 'Dsus4', 'Cadd9', 'Am7(11)', 'Db/F', 'D#m', 'C#', 'E6', 'A4', 'D2', 'Bm7/A', 'Gmaj7', 'C9', 'Bb7(13)']) {
    assert.ok(CHORD_TOKEN.test(c), c);
  }
  for (const w of ['Esse', 'Amor', 'Deus', 'Ele', 'Cristo', 'Bom', 'Fé', 'Em7M7x']) {
    assert.ok(!CHORD_TOKEN.test(w), w);
  }
});

test('"[Intro] F# B7M" and chord lines with 7M are converted', () => {
  const out = chordsOverLyricsToChordPro('[Intro] F#  B7M  F#  B7M\n\nF#           B7M\nEsse é o meu respirar\n');
  assert.ok(out.startsWith('{Intro}[ F# | B7M | F# | B7M ]'), out);
  assert.ok(out.includes('[F#]Esse é o meu [B7M]respirar'), out);
});
