import { chordToNashville, nashvilleToChord } from './transpose.ts';

const CHORD_TOKEN = new RegExp(
  '^[A-G](#|b)?(m|maj|min|dim|aug|sus2|sus4|sus|add\\d{1,2})?(\\d{1,2})?(\\([^)]*\\))?(/[A-G](#|b)?m?)?$'
);

const METADATA_LINE = /^\s*(Tom\s*:|Capotraste\b|Afina[cç][aã]o\s*:)/i;

/** A whole line wrapped in a single pair of brackets, e.g. "[Intro]" or
 * "[Primeira Parte]" — how Cifra Club marks section labels. Distinguished
 * from a real bracketed chord (which the caller checks separately) so
 * `[E]` on its own line isn't mistaken for a section marker. */
const SECTION_LABEL_LINE = /^\[([^\]]+)\]$/;

/** One string of an ASCII guitar-tab block, e.g. "e|--0---2----3--|" or
 * "E|-----------------|". Requires the leading string-letter (EADGBe, the
 * standard tuning) plus a run of tab notation — including technique letters
 * (h/p hammer-on/pull-off, b/r bend/release, s slide, t tap) — so a stray
 * lyric/chord line starting with one of those letters isn't mistaken for tab. */
const TAB_LINE_RE = /^\s*[eEADGB]\|[-\d/\\~hpxbrst() ]{4,}\|?\s*$/;

/** A Cifra Club section label introducing a tab block, e.g. "[Tab - Intro]"
 * or "[Tab - Solo Intro]" — dropped along with its tab lines so it doesn't
 * end up as an orphaned, content-less header. */
const TAB_SECTION_LABEL_RE = /^\[\s*tab\b[^\]]*\]\s*$/i;

/** Strips ASCII guitar-tab blocks (and their "[Tab - ...]" labels) out of raw
 * Cifra Club text, leaving chords/lyrics untouched — used when the user opts
 * into "eliminar tablaturas" on import (see app/api/search/route.ts). */
export function removeTablature(rawText: string): string {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (TAB_SECTION_LABEL_RE.test(lines[i])) {
      i += 1; // drop the label itself; any tab lines below are handled next
      continue;
    }
    if (TAB_LINE_RE.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && TAB_LINE_RE.test(lines[j])) j += 1;
      i = j; // one or more consecutive string lines — skip them all
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function isChordLine(line: string): boolean {
  const words = line.match(/\S+/g);
  if (!words || words.length === 0) return false;
  return words.every((w) => CHORD_TOKEN.test(w));
}

/** A chord with nothing after it on the line (end of line right after the
 * closing bracket) would otherwise produce an empty lyric chunk, and
 * ChordProView's beat-mark underline has nothing to underline for an empty
 * chunk — pad it with two spaces so the mark still has something to render. */
function padTrailingChord(line: string): string {
  return line.endsWith(']') ? `${line}  ` : line;
}

function chordLineToBracketed(line: string): string {
  const words = line.match(/\S+/g) || [];
  return words.map((w) => `[${w}]`).join(' ');
}

function mergeChordAndLyric(chordLine: string, lyricLine: string): string {
  const matches = [...chordLine.matchAll(/\S+/g)];
  let result = lyricLine;
  let offset = 0;
  for (const m of matches) {
    const chord = m[0];
    const col = (m.index ?? 0) + offset;
    if (col > result.length) {
      result += ' '.repeat(col - result.length);
    }
    const insertion = `[${chord}]`;
    result = result.slice(0, col) + insertion + result.slice(col);
    offset += insertion.length;
  }
  return result;
}

/** "[Intro] A  Em7  G  D" — a section label followed by its chords on the
 * same line (how Cifra Club writes intros/instrumental parts). */
const LABELED_CHORD_LINE = /^\s*\[([^\]]+)\]\s+(\S.*)$/;

/** "Intro: D D Bm Bm" — the same, written with a colon instead of brackets
 * (metadata like "Tom: D" is filtered out before this is checked). */
const COLON_CHORD_LINE = /^\s*([A-Za-zÀ-ÿ][^:[\]{}]{0,30}?)\s*:\s*(\S.*)$/;

function labeledChordLine(line: string): { label: string; chords: string[] } | null {
  const m = line.match(LABELED_CHORD_LINE) ?? line.match(COLON_CHORD_LINE);
  if (!m || CHORD_TOKEN.test(m[1]) || !isChordLine(m[2])) return null;
  return { label: m[1].trim(), chords: m[2].match(/\S+/g) ?? [] };
}

function isSectionStart(line: string): boolean {
  const label = line.trim().match(SECTION_LABEL_LINE);
  return (!!label && !CHORD_TOKEN.test(label[1])) || labeledChordLine(line) !== null;
}

const MAX_PROGRESSION_CHORDS = 8;

/** One cycle of a section's chord progression for its tag: the chords in
 * order (repeats in a row collapsed) up to where the first chord comes back,
 * e.g. A F#m D A F#m D2 A → A | F#m | D. */
function sectionProgression(chords: string[]): string[] {
  const seq = chords.filter((c, i) => c !== chords[i - 1]);
  const cycle = seq.indexOf(seq[0], 1);
  return seq.slice(0, cycle > 0 ? cycle : seq.length).slice(0, MAX_PROGRESSION_CHORDS);
}

/** "{Primeira Parte}[ A | F#m | D ]" — the same tag-with-progression shape
 * used in hand-written songs, which ChordProView renders as one badge
 * ("Primeira Parte - 1 | 6m | 4"). A single chord can't use the "|" form
 * (see TAG_CHORD_BRACKET), so it stays a separate chord chunk. */
function tagWithProgression(label: string, chords: string[]): string {
  if (chords.length === 0) return `{${label}}`;
  if (chords.length === 1) return `{${label}} [${chords[0]}]`;
  return `{${label}}[ ${chords.join(' | ')} ]`;
}

/** A `{tag}` alone on its line — a section header with no progression yet. */
const BARE_TAG_LINE = /^\s*\{([^:{}]+)\}\s*$/;

/** For the "acordes nas tags" button: gives every bare `{tag}` line the
 * progression of its section — the chords in brackets up to the next tag,
 * one cycle (see sectionProgression) — as "{Tag}[ 1 | 6m | 4 ]". Tags that
 * already carry chords on their line are left alone, as are sections with
 * no chords. Works on graus or concrete chords alike. */
export function addSectionProgressions(chordpro: string): string {
  const lines = chordpro.split('\n');
  const isTagLine = (l: string) => /^\s*\{[^:{}]+\}/.test(l);
  return lines
    .map((line, i) => {
      const tag = line.match(BARE_TAG_LINE);
      if (!tag) return line;
      const chords: string[] = [];
      for (let j = i + 1; j < lines.length && !isTagLine(lines[j]); j++) {
        if (DIRECTIVE_LINE.test(lines[j])) continue;
        for (const m of lines[j].matchAll(/\[([^\]|]+)\]/g)) {
          const chord = m[1].trim();
          if (chord && chord !== '%') chords.push(chord);
        }
      }
      return tagWithProgression(tag[1].trim(), sectionProgression(chords));
    })
    .join('\n');
}

/**
 * Converts "chords-above-lyrics" plain text (the format Cifra Club renders
 * inside its <pre> block) into a ChordPro-annotated body.
 */
export function chordsOverLyricsToChordPro(rawText: string): string {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (METADATA_LINE.test(line)) {
      i += 1;
      continue;
    }
    const labeled = labeledChordLine(line);
    if (labeled) {
      out.push(tagWithProgression(labeled.label, labeled.chords));
      i += 1;
      continue;
    }
    const sectionMatch = line.trim().match(SECTION_LABEL_LINE);
    if (sectionMatch && !CHORD_TOKEN.test(sectionMatch[1])) {
      const sectionChords: string[] = [];
      for (let j = i + 1; j < lines.length && !isSectionStart(lines[j]); j++) {
        if (isChordLine(lines[j])) sectionChords.push(...(lines[j].match(/\S+/g) ?? []));
      }
      out.push(tagWithProgression(sectionMatch[1], sectionProgression(sectionChords)));
      i += 1;
      continue;
    }
    if (isChordLine(line)) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== '' && !isChordLine(next)) {
        out.push(padTrailingChord(mergeChordAndLyric(line, next)));
        i += 2;
        continue;
      }
      out.push(padTrailingChord(chordLineToBracketed(line)));
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      // Trim only leading/trailing blank lines, not padTrailingChord's
      // spaces if a padded chord line ends up being the very last line.
      .replace(/^\n+|\n+$/g, '') + '\n'
  );
}

export interface SongMeta {
  title: string;
  artist: string;
  key?: string;
  /** Tom menor original da música, quando `key` já é o relativo maior
   * substituto (ver relativeMajorKey em lib/transpose.ts) — só guardado
   * para mostrar o disclaimer na visualização, nunca usado em conversão. */
  originalMinorKey?: string;
  capo?: string;
  sourceUrl?: string;
  /** `key` foi deduzido pelos acordes (a página não informava o tom). */
  keyInferred?: boolean;
}

/** Joins each section's lines into one, so the view wraps them only where
 * they overflow the frame (between words) instead of at Cifra Club's short
 * line breaks — applied on demand by the "juntar linhas" button in the code
 * view. Sections are delimited by `{tag}` lines, which stay on their own
 * line with a blank line before them; `{key: ...}`-style directives also
 * stay on their own lines. */
export function flowSections(body: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    if (DIRECTIVE_LINE.test(line)) {
      flush();
      out.push(line.trimEnd());
      continue;
    }
    if (/^\s*\{[^:{}]+\}/.test(line)) {
      flush();
      if (out.length) out.push('');
      out.push(line.trimEnd());
      continue;
    }
    paragraph.push(paragraph.length ? line.trim() : line.trimEnd());
  }
  flush();
  return out.join('\n') + '\n';
}

export function buildChordPro(meta: SongMeta, rawCifraText: string): string {
  const body = chordsOverLyricsToChordPro(rawCifraText);
  const header: string[] = [];
  header.push(`{title: ${meta.title}}`);
  header.push(`{artist: ${meta.artist}}`);
  if (meta.key) header.push(`{key: ${meta.key}}`);
  if (meta.originalMinorKey) header.push(`{originalkey: ${meta.originalMinorKey}}`);
  if (meta.capo) header.push(`{capo: ${meta.capo}}`);
  if (meta.sourceUrl) header.push(`{comment: Fonte - ${meta.sourceUrl}}`);
  if (meta.keyInferred) {
    header.push(`{comment: <Tom ${meta.key} deduzido pelos acordes - o Cifra Club não informava o tom>}`);
  }
  return `${header.join('\n')}\n\n${body}`;
}

export interface ChordProHeader {
  title?: string;
  artist?: string;
  key?: string;
  /** Presente só quando a música foi detectada num tom menor e reapresentada
   * no relativo maior (`key`) — ver SongMeta.originalMinorKey acima. */
  originalMinorKey?: string;
  capo?: string;
  comments: string[];
}

const DIRECTIVE_LINE = /^\s*\{(\w+):\s*(.*)\}\s*$/;

/** Reads the {title}/{artist}/{key}/{originalkey}/{capo}/{comment}
 * directives out of a ChordPro document, wherever they are — useful so that
 * editing the header directly in the raw text stays the single source of
 * truth. */
export function parseChordProHeader(text: string): ChordProHeader {
  const header: ChordProHeader = { comments: [] };
  for (const line of text.split('\n')) {
    const m = line.match(DIRECTIVE_LINE);
    if (!m) continue;
    const [, directive, value] = m;
    const trimmed = value.trim();
    switch (directive.toLowerCase()) {
      case 'title':
        header.title = trimmed;
        break;
      case 'artist':
        header.artist = trimmed;
        break;
      case 'key':
        header.key = trimmed;
        break;
      case 'originalkey':
        header.originalMinorKey = trimmed;
        break;
      case 'capo':
        header.capo = trimmed;
        break;
      case 'comment':
        header.comments.push(trimmed);
        break;
    }
  }
  return header;
}

/** Matches either a `[Chord]` token or a brace tag with no `directive:`
 * prefix, e.g. "{Intro}" or "{Refrão}" (as opposed to a `{key: ...}`-style
 * header directive). Captured with a global flag so a line can be split
 * into chord/tag/lyric pieces in source order, e.g.
 * "{Intro} [1] [%] [4] [%]" or "[1] [%] {Verso 1}". */
const CHORD_OR_TAG_TOKEN = /(\[[^\]]+\]|\{[^:{}]+\})/g;

export type ChordProChunk =
  | { kind: 'chord'; chord: string | null; lyric: string }
  | { kind: 'tag'; label: string };
export type ChordProBodyLine =
  | { type: 'chords'; chunks: ChordProChunk[] }
  | { type: 'text'; text: string }
  | { type: 'blank' };

/** A body line that's nothing but a single `{tag}` — no chords, no lyrics. */
function isTagOnlyLine(
  line: ChordProBodyLine
): line is { type: 'chords'; chunks: [{ kind: 'tag'; label: string }] } {
  return line.type === 'chords' && line.chunks.length === 1 && line.chunks[0].kind === 'tag';
}

/** A body line that's purely chords with no lyric text attached — an
 * instrumental progression like "[1] [%] [4] [%]" rather than chords over
 * a sung line. */
function isChordOnlyLine(
  line: ChordProBodyLine
): line is { type: 'chords'; chunks: ChordProChunk[] } {
  return (
    line.type === 'chords' &&
    line.chunks.length > 0 &&
    line.chunks.every((c) => c.kind === 'chord' && c.lyric.trim() === '')
  );
}

/** A lone {tag} line sitting directly next to a chord-only line reads better
 * joined onto one visual row than stacked — e.g. "[1] [%] [4] [%]" followed
 * by "{Verso 1}" becomes one "1 | % | 4 | %   Verso 1" line (and the same
 * joined either way round, tag-then-chords or chords-then-tag — ChordPro
 * exports from Cifra Club put the progression before the label). Only these
 * two exact shapes qualify: a bare tag and a line with no free lyric text,
 * so a tag sitting above/below an actual sung line is left alone. */
function mergeAdjacentTagAndChordLines(lines: ChordProBodyLine[]): ChordProBodyLine[] {
  const merged: ChordProBodyLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    if (next && isTagOnlyLine(cur) && isChordOnlyLine(next)) {
      merged.push({
        type: 'chords',
        chunks: [...cur.chunks, { kind: 'chord', chord: null, lyric: ' ' }, ...next.chunks],
      });
      i += 1;
      continue;
    }
    if (next && isChordOnlyLine(cur) && isTagOnlyLine(next)) {
      merged.push({
        type: 'chords',
        chunks: [...cur.chunks, { kind: 'chord', chord: null, lyric: ' ' }, ...next.chunks],
      });
      i += 1;
      continue;
    }
    merged.push(cur);
  }
  return merged;
}

/** Placeholder for a real newline that falls inside a `<...>` annotation, so
 * the line-splitting below doesn't break a multi-line annotation (e.g. a
 * long performance note) into separate, unrecognizable lines. Restored back
 * to a line break at render time — see ANNOTATION_NEWLINE usage in
 * ChordProView. U+2028 (line separator) is used since it never otherwise
 * appears in these documents. */
export const ANNOTATION_NEWLINE = String.fromCharCode(0x2028);

function protectAnnotationNewlines(text: string): string {
  return text.replace(/<[^>]*>/g, (m) => m.replace(/\n/g, ANNOTATION_NEWLINE));
}

/** A `{tag}` followed — glued or with any run of same-line whitespace in
 * between (regular space/tab, but also e.g. a non-breaking space pasted in
 * from Notion/Docs) — by a single `[progression]` bracket containing a
 * "|", e.g. "{Refrão}[ 4 | 2m | 1 | 6m ]" or "{Ponte} [ 47M | 54 | 6m7 |
 * 3m7 ]" — reads better as one badge than a tag pill glued to a separate
 * chord chunk, so it's folded into the tag's own label: "{Ponte - 47M | 54
 * | 6m7 | 3m7 }" (the tag-label extraction below trims it either way, so
 * the trailing space doesn't end up in the rendered badge). Requiring the
 * "|" is what keeps this from also swallowing "{Intro} [1] [%]" — real
 * separate chord tokens, not one progression bracket, must stay alone.
 * `[^\S\r\n]` is "whitespace that isn't a line break" — covers Unicode
 * spaces (nbsp included) without letting the match cross lines. */
const TAG_CHORD_BRACKET = /\{([^:{}]+)\}[^\S\r\n]*\[([^\]]*\|[^\]]*)\]/g;

function mergeTagWithChordBracket(text: string): string {
  return text.replace(
    TAG_CHORD_BRACKET,
    (_, tag: string, content: string) => `{${tag} - ${content.replace(/^\s+/, '')}}`
  );
}

/** Splits a ChordPro body into lines ready for a "chords above lyrics"
 * rendering: each chunk pairs a chord with the syllable/word it sits above.
 * `{tag}` tokens become their own chunk (rendered plain, not as a chord)
 * without ever inserting a line break the source didn't already have —
 * line breaks are entirely up to how the ChordPro text is written. */
export function parseChordProBody(text: string): ChordProBodyLine[] {
  const result: ChordProBodyLine[] = [];
  for (const line of protectAnnotationNewlines(mergeTagWithChordBracket(text)).split('\n')) {
    if (DIRECTIVE_LINE.test(line)) continue;
    if (line.trim() === '') {
      result.push({ type: 'blank' });
      continue;
    }
    if (!line.includes('[') && !/\{[^:{}]+\}/.test(line)) {
      result.push({ type: 'text', text: line });
      continue;
    }
    const chunks: ChordProChunk[] = [];
    let pendingChord: string | null = null;
    const flushPendingChord = () => {
      if (pendingChord !== null) {
        chunks.push({ kind: 'chord', chord: pendingChord, lyric: '' });
        pendingChord = null;
      }
    };
    for (const part of line.split(CHORD_OR_TAG_TOKEN)) {
      if (part === '') continue;
      const chordMatch = part.match(/^\[([^\]]+)\]$/);
      if (chordMatch) {
        flushPendingChord();
        pendingChord = chordMatch[1];
        continue;
      }
      const tagMatch = part.match(/^\{([^:{}]+)\}$/);
      if (tagMatch) {
        flushPendingChord();
        chunks.push({ kind: 'tag', label: tagMatch[1].trim() });
        continue;
      }
      chunks.push({ kind: 'chord', chord: pendingChord, lyric: part });
      pendingChord = null;
    }
    flushPendingChord();
    result.push({ type: 'chords', chunks });
  }
  return mergeAdjacentTagAndChordLines(result);
}

const CHORD_BRACKET = /\[([^\]]+)\]/g;

/** Rewrites every `[Chord]` token in a ChordPro document into its Nashville
 * Number equivalent relative to `key`. Directives, lyrics and blank lines are
 * left untouched — only the bracketed chord tokens change. */
/** Applies `convert` to a bracket's chord — or to each chord of a "|"
 * progression bracket like "[ A | F#m | D ]", keeping its spacing. */
function convertBracket(token: string, convert: (chord: string) => string): string {
  if (!token.includes('|')) return convert(token);
  return token
    .split('|')
    .map((part) => part.replace(/\S+/, (chord) => convert(chord)))
    .join('|');
}

export function convertChordProToNashville(chordpro: string, key: string): string {
  return chordpro.replace(
    CHORD_BRACKET,
    (_, token) => `[${convertBracket(token, (c) => chordToNashville(c, key))}]`
  );
}

/** Inverse of convertChordProToNashville: rewrites every `[degree]` token
 * back into a concrete chord for `key`. */
export function convertChordProFromNashville(chordpro: string, key: string): string {
  return chordpro.replace(
    CHORD_BRACKET,
    (_, token) => `[${convertBracket(token, (c) => nashvilleToChord(c, key))}]`
  );
}
