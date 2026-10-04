/**
 * Transposition engine between concrete chords (C, F#m7, G/B) and Nashville
 * Number System tokens (1, 4m7, 5/7) relative to a song's key.
 *
 * Degree numbers always use major-scale intervals from the tonic — this is
 * the standard Nashville Number System convention, and it's what makes the
 * familiar b3/b6/b7 borrowed-chord labels come out right even for songs in a
 * minor key (e.g. the C chord in the key of Am is "b3", not a natural-minor
 * "3"). Only the chord's root moves; its quality/extension suffix and any
 * slash-bass are preserved as-is (the bass root is converted the same way).
 */

export class InvalidKeyError extends Error {
  constructor(key: string) {
    super(`Tom inválido ou não reconhecido: "${key}".`);
  }
}

const NOTE_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

function noteToSemitone(letter: string, accidental?: string): number {
  let semitone = NOTE_SEMITONES[letter];
  if (accidental === '#') semitone += 1;
  if (accidental === 'b') semitone -= 1;
  return ((semitone % 12) + 12) % 12;
}

function semitoneToNote(semitone: number, preferFlats: boolean): string {
  const table = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  return table[((semitone % 12) + 12) % 12];
}

const KEY_RE = /^([A-G])(#|b)?m?$/;

interface ParsedKey {
  tonic: number;
  preferFlats: boolean;
}

function parseKey(key: string): ParsedKey {
  const m = key.trim().match(KEY_RE);
  if (!m) throw new InvalidKeyError(key);
  const [, letter, accidental] = m;
  const preferFlats = accidental === 'b' || (!accidental && letter === 'F');
  return { tonic: noteToSemitone(letter, accidental), preferFlats };
}

/** Maps a semitone distance-from-tonic (0-11) to a Nashville degree label
 * (e.g. "4", "b7", "#1"). Diatonic (major-scale) pitches map exactly;
 * chromatic pitches always fall in a whole-tone gap between two scale
 * degrees and are spelled as the flat of the degree above — matching the
 * "b3"/"b6"/"b7" borrowed-chord convention used on gospel/worship charts. */
function distanceToDegree(distance: number): string {
  const exactIdx = MAJOR_SCALE.indexOf(distance);
  if (exactIdx !== -1) return String(exactIdx + 1);
  const flatIdx = MAJOR_SCALE.findIndex((offset) => offset === distance + 1);
  if (flatIdx !== -1) return `b${flatIdx + 1}`;
  const sharpIdx = MAJOR_SCALE.findIndex((offset) => offset === distance - 1);
  if (sharpIdx !== -1) return `#${sharpIdx + 1}`;
  return String(distance);
}

function degreeToDistance(accidental: string | undefined, degree: number): number {
  const base = MAJOR_SCALE[degree - 1];
  const offset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return (((base + offset) % 12) + 12) % 12;
}

/** Mirrors the chord grammar validated by CHORD_TOKEN in lib/chordpro.ts,
 * with named groups since the root/bass need to be pulled apart to do the
 * transposition math. */
const CHORD_PARSE_RE = /^([A-G])(#|b)?([^/]*)(?:\/([A-G])(#|b)?(m?))?$/;

function chordRootToDegree(letter: string, accidental: string | undefined, tonic: number): string {
  const distance = (noteToSemitone(letter, accidental) - tonic + 12) % 12;
  return distanceToDegree(distance);
}

/** Converts one chord token (e.g. "Am7", "G/B") into its Nashville Number
 * equivalent relative to `key` (e.g. "6m7", "5/7"). Tokens that don't start
 * with a valid chord root (e.g. "N.C.") are returned unchanged. */
export function chordToNashville(token: string, key: string): string {
  const parsedKey = parseKey(key);
  const m = token.match(CHORD_PARSE_RE);
  if (!m) return token;
  const [, letter, accidental, suffix, bassLetter, bassAccidental, bassMinor] = m;

  let result = chordRootToDegree(letter, accidental, parsedKey.tonic) + suffix;
  if (bassLetter) {
    result += `/${chordRootToDegree(bassLetter, bassAccidental, parsedKey.tonic)}${bassMinor || ''}`;
  }
  return result;
}

const NASHVILLE_PARSE_RE = /^(#|b)?([1-7])([^/]*)(?:\/(#|b)?([1-7])(m?))?$/;

function degreeToChordRoot(accidental: string | undefined, degree: number, parsedKey: ParsedKey): string {
  const distance = degreeToDistance(accidental, degree);
  return semitoneToNote(parsedKey.tonic + distance, parsedKey.preferFlats);
}

/** Inverse of chordToNashville: converts a Nashville Number token (e.g.
 * "6m7", "5/7") back into a concrete chord for `key` (e.g. "Am7", "G/B").
 * Tokens that don't start with a valid degree (1-7) are returned unchanged. */
export function nashvilleToChord(token: string, key: string): string {
  const parsedKey = parseKey(key);
  const m = token.match(NASHVILLE_PARSE_RE);
  if (!m) return token;
  const [, accidental, degree, suffix, bassAccidental, bassDegree, bassMinor] = m;

  let result = degreeToChordRoot(accidental, Number(degree), parsedKey) + suffix;
  if (bassDegree) {
    result += `/${degreeToChordRoot(bassAccidental, Number(bassDegree), parsedKey)}${bassMinor || ''}`;
  }
  return result;
}

/** True for a minor-key string like "Dm", "F#m", "Bbm" — as opposed to a
 * bare major key like "D". */
export function isMinorKey(key: string): boolean {
  return /^[A-G](#|b)?m$/.test(key.trim());
}

/** The relative major of a minor key (e.g. "Dm" -> "F") — same key
 * signature, a minor third above the minor tonic. Songs detected in a minor
 * key are presented in graus relative to this key instead (grau 1 = the
 * relative major's tonic), so the "6m"/"2m"/etc borrowed-chord labels read
 * naturally instead of centering everything on a "1m" tonic — see the
 * disclaimer rendered in ChordProView when a song carries this. */
export function relativeMajorKey(minorKey: string): string {
  const parsed = parseKey(minorKey);
  const majorTonic = (parsed.tonic + 3) % 12;
  return semitoneToNote(majorTonic, parsed.preferFlats);
}

const MINOR_DEGREES = new Set([2, 4, 9]); // 2m, 3m, 6m
const SHARP_KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Best-guess major key for a list of chords (in song order), for cifras
 * whose page didn't state a "Tom:". Each key scores how well its diatonic
 * chords (1, 2m, 3m, 4, 5, 6m) cover the song's chords; the tonic chord
 * counts double (it's usually the most frequent one), the borrowed b7 (G in
 * A — very common in worship songs) counts half, and starting/ending on the
 * tonic adds a bonus. Without those, a song in A with G and Em7 scores higher
 * in D. Returns undefined with no chords. */
export function inferKeyFromChords(chords: string[]): string | undefined {
  const parsed = chords
    .map((c) => c.match(CHORD_PARSE_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, letter, accidental, suffix]) => ({
      root: noteToSemitone(letter, accidental),
      minor: /^m(?!aj)/.test(suffix),
      sharp: accidental === '#',
    }));
  if (parsed.length === 0) return undefined;

  let bestTonic = 0;
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    let score = 0;
    for (const c of parsed) {
      const distance = (c.root - tonic + 12) % 12;
      if (distance === 0 && !c.minor) score += 2;
      else if (distance === 10 && !c.minor) score += 0.5; // b7 emprestado
      else if (distance === 11) continue; // 7º grau (diminuto) é raro — não conta
      else if (MAJOR_SCALE.includes(distance)) {
        score += MINOR_DEGREES.has(distance) === c.minor ? 1 : 0.5;
      }
    }
    const first = parsed[0];
    const last = parsed[parsed.length - 1];
    if (first.root === tonic && !first.minor) score += 3;
    if (last.root === tonic && !last.minor) score += 2;
    if (score > bestScore) {
      bestScore = score;
      bestTonic = tonic;
    }
  }
  const names = parsed.some((c) => c.sharp) ? SHARP_KEY_NAMES : FLAT_KEY_NAMES;
  return names[bestTonic];
}
