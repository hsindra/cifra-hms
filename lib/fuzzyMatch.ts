import { slugify } from './slugify.ts';

/** Minimum score (see songMatchScore) for a saved song to be considered a
 * match — chosen to tolerate typos/partial words without surfacing unrelated
 * songs. */
export const MATCH_THRESHOLD = 0.5;

/** Short connective words that appear in lots of titles ("Mais Que a Neve",
 * "Tudo é Teu") and would otherwise make unrelated songs look like matches. */
const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na',
  'nos', 'nas', 'um', 'uma', 'que', 'pra', 'pro', 'para', 'por', 'com', 'se', 'p',
]);

/** Whether a typed token matches a token of the song: equal, a prefix of it
 * (typing in progress), contained in it (3+ letters), or containing it — the
 * last only for 4+ letter song tokens, so "é"/"a" don't match inside "que". */
function tokenMatches(qt: string, tt: string): boolean {
  if (tt.startsWith(qt)) return true;
  if (qt.length >= 3 && tt.includes(qt)) return true;
  return tt.length >= 4 && qt.includes(tt);
}

/** Rough 0-1 fuzzy match between what the user typed and a song's title +
 * artist. Tolerant of partial words (so it also works for live typeahead
 * while the user is still typing) and doesn't require an exact match. */
export function songMatchScore(query: string, title: string, artist: string): number {
  const allQueryTokens = slugify(query).split('-').filter(Boolean);
  // Stopwords não contam — a menos que a busca seja só delas.
  const contentTokens = allQueryTokens.filter((t) => !STOPWORDS.has(t));
  const queryTokens = contentTokens.length > 0 ? contentTokens : allQueryTokens;
  if (queryTokens.length === 0) return 0;
  const targetTokens = slugify(`${artist} ${title}`).split('-').filter(Boolean);
  if (targetTokens.length === 0) return 0;

  const matched = queryTokens.filter((qt) => targetTokens.some((tt) => tokenMatches(qt, tt)));
  return matched.length / queryTokens.length;
}
