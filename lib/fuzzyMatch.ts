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

/** Rough 0-1 match between what the user typed and a song's title + artist:
 * the fraction of typed words (ignoring stopwords) that appear as whole words
 * in the song — "pé" doesn't match "Pedras". With `prefixLast` (live typeahead)
 * the last typed word may also be the start of a song word, since the user is
 * still typing it. */
export function songMatchScore(
  query: string,
  title: string,
  artist: string,
  { prefixLast = false }: { prefixLast?: boolean } = {}
): number {
  const allQueryTokens = slugify(query).split('-').filter(Boolean);
  // Stopwords não contam — a menos que a busca seja só delas.
  const contentTokens = allQueryTokens.filter((t) => !STOPWORDS.has(t));
  const queryTokens = contentTokens.length > 0 ? contentTokens : allQueryTokens;
  if (queryTokens.length === 0) return 0;
  const targetTokens = slugify(`${artist} ${title}`).split('-').filter(Boolean);
  if (targetTokens.length === 0) return 0;

  // O último token só pode ser prefixo se for de fato a palavra sendo digitada
  // (não uma stopword descartada que vinha depois dele).
  const lastIsTyping =
    prefixLast && queryTokens[queryTokens.length - 1] === allQueryTokens[allQueryTokens.length - 1];
  const matched = queryTokens.filter((qt, i) => {
    const canPrefix = lastIsTyping && i === queryTokens.length - 1;
    return targetTokens.some((tt) => tt === qt || (canPrefix && tt.startsWith(qt)));
  });
  return matched.length / queryTokens.length;
}
