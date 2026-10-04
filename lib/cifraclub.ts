import * as cheerio from 'cheerio';
import { slugify } from './slugify';
import { inferKeyFromChords } from './transpose';
import { CHORD_TOKEN } from './chordpro';

type Node = {
  type: string;
  name?: string;
  data?: string;
  children?: Node[];
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const BASE_URL = 'https://www.cifraclub.com.br';

interface FetchResult {
  ok: boolean;
  status: number;
  html: string | null;
}

async function fetchHtml(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status, html: null };
    return { ok: true, status: res.status, html: await res.text() };
  } catch {
    return { ok: false, status: 0, html: null };
  }
}

/** Extracts text from a <pre> element, preserving line breaks and whitespace. */
function extractPreText(el: unknown): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.type === 'text') {
      out += node.data ?? '';
    } else if (node.type === 'tag') {
      if (node.name === 'br') {
        out += '\n';
        return;
      }
      for (const child of node.children || []) walk(child);
    }
  };
  const root = el as Node;
  for (const child of root.children || []) walk(child);
  return out;
}



function scorePreAsCifra(text: string): number {
  const lines = text.split('\n').slice(0, 40);
  let score = 0;
  for (const line of lines) {
    const words = line.match(/\S+/g);
    if (!words || words.length === 0) continue;
    if (words.every((w) => CHORD_TOKEN.test(w))) score += words.length;
  }
  return score;
}

/** "Tom: A" as it appears in the page text — in the scrape it may be "tom:",
 * with the chord wrapped as a markdown link/bold or on the next line. */
function findKey(pageText: string): RegExpMatchArray | null {
  return (
    pageText.match(/Tom\s*:?\s*([A-G](?:#|b)?m?)/) ??
    pageText.match(/\b[Tt][Oo][Mm]\b[^A-Za-z0-9]{0,15}([A-G](?:#|b)?m?)(?![A-Za-z0-9#])/)
  );
}

/** Every chord in the cifra's chord-only lines, in order. */
function chordsIn(text: string): string[] {
  const chords: string[] = [];
  for (const line of text.split('\n')) {
    // "[Intro] A Em7 G D" também conta — ignora o rótulo da seção.
    if (isChordOnlyLine(line)) chords.push(...line.replace(/^\s*\[[^\]]*\]/, '').match(/\S+/g)!);
  }
  return chords;
}

export interface CifraPage {
  title: string;
  artist: string;
  key?: string;
  capo?: string;
  rawText: string;
  sourceUrl: string;
  /** `key` foi deduzido pelos acordes, não lido da página. */
  keyInferred?: boolean;
}

function looksLikeSongPage(html: string): boolean {
  return /<pre/i.test(html) && /cifraclub/i.test(html);
}

/** Validates and normalizes a user-supplied Cifra Club URL (adds a scheme if
 * missing, ensures a trailing slash). Returns null if it isn't a cifraclub.com.br
 * URL at all. */
export function normalizeCifraUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!/(^|\.)cifraclub\.com\.br$/i.test(url.hostname)) return null;
  url.protocol = 'https:';
  url.hostname = 'www.cifraclub.com.br';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Thrown when we can positively tell the request was blocked, so callers can
 * surface a clearer message than a plain "not found". */
export class CifraAccessError extends Error {
  status: number;
  constructor(status: number, detail?: string) {
    super(`Cifra Club recusou o acesso (HTTP ${status})${detail ? `; ${detail}` : ''}.`);
    this.status = status;
  }
}

/** Thrown when SERPER_API_KEY isn't set, or Serper rejects it. */
export class SearchConfigError extends Error {
  constructor() {
    super('Busca não configurada: defina a variável de ambiente SERPER_API_KEY (veja serper.dev).');
  }
}

interface SerperSearchResponse {
  organic?: { link?: string }[];
}

/** Candidate song URLs from the Serper (Google SERP) API, restricted to
 * cifraclub.com.br (unvalidated — callers confirm each one is a real cifra
 * page before showing it). */
async function serperSearchCandidates(query: string): Promise<string[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new SearchConfigError();

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: `site:cifraclub.com.br ${query}` }),
  });
  if (res.status === 401 || res.status === 403) throw new SearchConfigError();
  if (!res.ok) {
    // Ex: créditos esgotados — sem isso o erro virava um "0 link(s)" sem pista.
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Busca do Serper falhou (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`);
  }

  const data = (await res.json()) as SerperSearchResponse;
  const links: string[] = [];
  const seen = new Set<string>();
  for (const item of data.organic ?? []) {
    if (!item.link) continue;
    let url: URL;
    try {
      url = new URL(item.link);
    } catch {
      continue;
    }
    if (!/(^|\.)cifraclub\.com\.br$/.test(url.hostname)) continue;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) continue;
    const normalized = `${BASE_URL}/${segments.join('/')}/`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

function pathSegments(url: string): [string, string] {
  try {
    const [a, b] = new URL(url).pathname.split('/').filter(Boolean);
    return [a || '', b || ''];
  } catch {
    return ['', ''];
  }
}

/** Rough 0-1 similarity between two slugs, used to rank candidates by how close
 * their artist matches the one the user typed (helps pick the right cover among
 * several artists who recorded the same song). */
function slugSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const ta = new Set(a.split('-'));
  const tb = new Set(b.split('-'));
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union ? intersection / union : 0;
}

const MAX_CANDIDATES_TO_CHECK = 8;
/** Once the first page is in, how long to keep waiting for the rest — a
 * page through the proxy can take many seconds, and one slow candidate
 * shouldn't hold back the whole list. */
const RESULT_GRACE_MS = 3_000;

/** Like Promise.all, but once the first non-null value arrives it waits at
 * most `graceMs` for the others; any still pending count as null. */
async function settleWithGrace<T>(promises: Promise<T | null>[], graceMs: number): Promise<(T | null)[]> {
  const values: (T | null)[] = promises.map(() => null);
  let release: () => void = () => {};
  const graceOver = new Promise<void>((resolve) => (release = resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const all = Promise.all(
    promises.map((p, i) =>
      p.then((v) => {
        values[i] = v;
        if (v !== null && !timer) timer = setTimeout(release, graceMs);
      })
    )
  );
  await Promise.race([all, graceOver]);
  if (timer) clearTimeout(timer);
  return [...values];
}
const MAX_RESULTS = 6;
/** The scrape fallback costs Serper credits per page, so on a 403 only the
 * best-ranked candidates go through it. */
const MAX_SCRAPED_CANDIDATES = 4;

/** Thrown when no song page could be confirmed; carries a diagnostic breakdown
 * of how many candidates were found/checked at each step, since this is the
 * kind of thing that's much easier to debug from the error message than by
 * digging through serverless logs. */
export class CifraNotFoundError extends Error {
  constructor(detail: string) {
    super(`Não encontrei essa música no Cifra Club (${detail}).`);
  }
}

/**
 * Searches Cifra Club for a song and returns every match we could confirm as a
 * real cifra page, ranked by how well it matches what was typed. The artist is
 * optional and the match doesn't need to be exact — callers are expected to
 * show the list and let the user pick the right one (useful when several
 * artists recorded the same song).
 */
export async function searchCifra(artist: string, song: string): Promise<CifraPage[]> {
  const trimmedArtist = artist.trim();
  const trimmedSong = song.trim();
  if (!trimmedSong) return [];

  const rawCandidates = new Set<string>();
  if (trimmedArtist) {
    rawCandidates.add(`${BASE_URL}/${slugify(trimmedArtist)}/${slugify(trimmedSong)}/`);
  }

  const query = [trimmedArtist, trimmedSong].filter(Boolean).join(' ');
  const serper = await serperSearchCandidates(query);
  for (const url of serper) rawCandidates.add(url);

  let blocked: CifraAccessError | null = null;
  if (rawCandidates.size === 0) {
    throw new CifraNotFoundError(`serper: ${serper.length} link(s)`);
  }

  const artistSlug = slugify(trimmedArtist);
  const songSlug = slugify(trimmedSong);
  const ranked = [...rawCandidates]
    .map((url) => {
      const [seg1, seg2] = pathSegments(url);
      const songScore = slugSimilarity(songSlug, seg2 || seg1);
      const score = artistSlug ? slugSimilarity(artistSlug, seg1) * 0.7 + songScore * 0.3 : songScore;
      return { url, score };
    })
    .sort((a, b) => b.score - a.score)
    // Bloqueado: só os candidatos que podem ir pelo proxy valem a chamada.
    .slice(0, directLikelyBlocked() ? MAX_SCRAPED_CANDIDATES : MAX_CANDIDATES_TO_CHECK);

  const settled = await settleWithGrace(
    ranked.map(async ({ url }, i) => {
      try {
        return await fetchCifra(url, { allowScrape: i < MAX_SCRAPED_CANDIDATES });
      } catch (err) {
        // Guarda o erro mais informativo (o da raspagem, quando houver).
        if (err instanceof CifraAccessError && (!blocked || err.message.length > blocked.message.length)) {
          blocked = err;
        }
        return null;
      }
    }),
    RESULT_GRACE_MS
  );

  const results = settled.filter((r): r is CifraPage => r !== null);
  if (results.length === 0) {
    if (blocked) throw blocked;
    throw new CifraNotFoundError(
      `${ranked.length} candidato(s) verificado(s), nenhum confirmado como página de cifra`
    );
  }

  // Dedupe in case the same song was found under equivalent paths.
  const dedup = new Map<string, CifraPage>();
  for (const r of results) {
    const key = `${slugify(r.artist)}|${slugify(r.title)}`;
    if (!dedup.has(key)) dedup.set(key, r);
  }
  return [...dedup.values()].slice(0, MAX_RESULTS);
}

/** Picks the <pre>-like block that looks most like a cifra and pulls key/capo
 * out of the surrounding page text. Shared by the direct-HTML and scrape paths. */
function buildCifraPage(
  blocks: string[],
  pageText: string,
  title: string,
  artist: string,
  url: string
): CifraPage {
  const best = blocks
    .map((text) => ({ text, score: scorePreAsCifra(text) }))
    .reduce<{ text: string; score: number } | null>(
      (acc, cur) => (!acc || cur.score > acc.score ? cur : acc),
      null
    );
  if (!best || best.score === 0) {
    throw new Error('Não encontrei a cifra (bloco de acordes) nessa página.');
  }
  // "Tom: A" no HTML; na raspagem pode vir "tom:", e o acorde como link ou
  // negrito em markdown ("tom: [A](...)", "**A**").
  const keyMatch = findKey(pageText);
  const capoMatch = pageText.match(/Capotraste\s*(?:na)?\s*(\d+)[ªº]?\s*casa/i);
  return {
    title: title || 'Título desconhecido',
    artist: artist || 'Artista desconhecido',
    // Sem "Tom:" na página, deduz pelos acordes — melhor que descartar a cifra.
    key: keyMatch?.[1] ?? inferKeyFromChords(chordsIn(best.text)),
    keyInferred: !keyMatch,
    capo: capoMatch?.[1],
    rawText: best.text,
    sourceUrl: url,
  };
}

function parseCifraHtml(html: string, url: string): CifraPage {
  const $ = cheerio.load(html);
  const blocks = $('pre')
    .toArray()
    .map((el) => extractPreText(el));

  const title =
    $('h1.t1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.split(' - ')[0]?.trim() ||
    $('title').text().split(' - ')[0]?.trim() ||
    '';

  const artist =
    $('h2.t3 a').first().text().trim() ||
    $('.cifra-header a[href^="/"]').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.split(' - ')[1]?.trim() ||
    '';

  return buildCifraPage(blocks, $('body').text(), title, artist, url);
}

function isChordOnlyLine(line: string): boolean {
  const words = line.replace(/^\s*\[[^\]]*\]/, '').match(/\S+/g);
  return !!words && words.every((w) => CHORD_TOKEN.test(w));
}

/** The cifra part of a scraped markdown/text page: drops "# title" lines,
 * un-indents a 4-space indented code block, and keeps from the first section
 * label ("[Intro] A Em7 G D", "[Primeira Parte]") or chord line through the
 * last chord line plus the lyric lines right below it. */
function extractCifraSpan(source: string): string | null {
  let lines = source
    .replace(/\*\*|`/g, '')
    .split('\n')
    .filter((l) => !/^#{1,6}\s/.test(l));
  const nonBlank = lines.filter((l) => l.trim());
  if (nonBlank.length && nonBlank.filter((l) => l.startsWith('    ')).length >= nonBlank.length / 2) {
    lines = lines.map((l) => (l.startsWith('    ') ? l.slice(4) : l));
  }
  const isStart = (l: string) => isChordOnlyLine(l) || /^\s*\[[^\]]+\]\s*$/.test(l);
  const first = lines.findIndex(isStart);
  const lastChord = lines.findLastIndex(isChordOnlyLine);
  if (first < 0 || lastChord < 0) return null;
  let end = lastChord + 1;
  while (end < lines.length && lines[end].trim() && !isChordOnlyLine(lines[end])) end++;
  return lines.slice(first, end).join('\n');
}

interface SerperScrapeResponse {
  text?: string;
  markdown?: string;
  metadata?: Record<string, string | undefined>;
}

/** Fallback for when Cifra Club blocks our servers (HTTP 403, typically for
 * datacenter IPs like Vercel's): fetches the page through Serper's scrape
 * service, which uses the same SERPER_API_KEY. The <pre> comes back as a
 * fenced code block in the markdown. */
async function scrapeCifra(url: string): Promise<CifraPage> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new CifraAccessError(403, 'raspagem: SERPER_API_KEY ausente');
  let res: Response;
  try {
    res = await fetch('https://scrape.serper.dev', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, includeMarkdown: true }),
    });
  } catch (err) {
    throw new CifraAccessError(403, `raspagem: erro de rede (${String(err).slice(0, 100)})`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 150);
    throw new CifraAccessError(403, `raspagem: HTTP ${res.status}${body ? ` ${body}` : ''}`);
  }
  const data = (await res.json()) as SerperScrapeResponse;
  const markdown = data.markdown ?? '';
  const pageText = data.text ?? markdown;

  const blocks: string[] = [];
  for (const m of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    // Acordes podem vir em negrito/código dentro do bloco — limpa a marcação
    // sem mexer nos espaços (o alinhamento acorde/letra depende deles).
    blocks.push(m[1].replace(/\*\*|`/g, '').replace(/\n$/, ''));
  }

  // Sem ``` no markdown (o Serper devolve a cifra como bloco indentado com 4
  // espaços): pega do primeiro rótulo de seção/linha de acordes até a última
  // linha de acordes e a letra logo abaixo dela.
  if (blocks.length === 0) {
    for (const source of [markdown, data.text ?? '']) {
      const block = extractCifraSpan(source);
      if (block) blocks.push(block);
    }
  }

  const ogTitle = data.metadata?.['og:title'] ?? data.metadata?.title ?? '';
  const [title = '', artist = ''] = ogTitle.split(' - ').map((p) => p.trim());
  try {
    return buildCifraPage(blocks, pageText, title, artist, url);
  } catch {
    const preview = (markdown || pageText).replace(/\s+/g, ' ').slice(0, 150);
    throw new CifraAccessError(
      403,
      `raspagem veio sem cifra reconhecível (${markdown.length} chars de markdown, ${blocks.length} bloco(s)): "${preview}"`
    );
  }
}

/** Fetches a page's original HTML through ScraperAPI (SCRAPERAPI_KEY),
 * whose residential/rotating IPs get past Cifra Club's block on datacenter
 * IPs like Vercel's. Unlike the Serper scrape it returns the raw HTML, so the
 * "Tom:" and the chord-line indentation survive. `premium` uses residential
 * IPs only (more credits per page). */
async function fetchViaScraperApi(
  url: string,
  { premium = false }: { premium?: boolean } = {}
): Promise<FetchResult> {
  const apiKey = process.env.SCRAPERAPI_KEY;
  if (!apiKey) return { ok: false, status: 0, html: null };
  const params = new URLSearchParams({ api_key: apiKey, url, country_code: 'br' });
  if (premium) params.set('premium', 'true');
  try {
    const res = await fetch(`https://api.scraperapi.com/?${params}`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return { ok: false, status: res.status, html: null };
    return { ok: true, status: res.status, html: await res.text() };
  } catch {
    return { ok: false, status: 0, html: null };
  }
}

/** Cifra Club currently answers 403 to every direct request from our
 * servers; after one 403, skip the direct attempt for a while (per warm
 * serverless instance) and go straight to the proxy — saves a round trip
 * per page. */
const DIRECT_BLOCK_MEMORY_MS = 15 * 60_000;
let directBlockedUntil = 0;

function directLikelyBlocked(): boolean {
  return Date.now() < directBlockedUntil;
}

export async function fetchCifra(
  url: string,
  { allowScrape = true }: { allowScrape?: boolean } = {}
): Promise<CifraPage> {
  const res: FetchResult = directLikelyBlocked()
    ? { ok: false, status: 403, html: null }
    : await fetchHtml(url);
  if (res.status === 403) {
    directBlockedUntil = Date.now() + DIRECT_BLOCK_MEMORY_MS;
    if (!allowScrape) throw new CifraAccessError(403);
    // HTML original via ScraperAPI primeiro (tom e alinhamento corretos);
    // se não der, a raspagem do Serper (tom deduzido pelos acordes).
    const viaProxy = await fetchViaScraperApi(url);
    if (viaProxy.html) {
      try {
        return parseCifraHtml(viaProxy.html, url);
      } catch {
        // página sem cifra reconhecível (ex: tela de bloqueio) — cai pro Serper
      }
    }
    return scrapeCifra(url);
  }
  if (!res.html) {
    throw new Error(`Não foi possível acessar ${url} (HTTP ${res.status || 'erro de rede'}).`);
  }
  return parseCifraHtml(res.html, url);
}

/** Tries alternative Cifra Club addresses for the same song directly (no
 * scrape), reporting which ones aren't blocked and whether they carry the
 * key and the chord-line indentation. */
async function probeDirectVariants(url: string): Promise<Record<string, unknown>[]> {
  const path = new URL(url).pathname;
  const variants = [
    url,
    `https://cifraclub.com.br${path}`,
    `https://m.cifraclub.com.br${path}`,
    `https://www.cifraclub.com.br${path}imprimir.html`,
    `https://www.cifraclub.com.br${path}simplificada.html`,
  ];
  const attempts: { label: string; run: () => Promise<FetchResult> }[] = variants.map((v) => ({
    label: v,
    run: () => fetchHtml(v),
  }));
  if (process.env.SCRAPERAPI_KEY) {
    attempts.push({ label: 'scraperapi', run: () => fetchViaScraperApi(url) });
  } else {
    attempts.push({ label: 'scraperapi: SCRAPERAPI_KEY ausente', run: async () => ({ ok: false, status: 0, html: null }) });
  }
  return Promise.all(
    attempts.map(async ({ label: v, run }) => {
      const res = await run();
      const info: Record<string, unknown> = { url: v, status: res.status };
      if (!res.html) return info;
      info.length = res.html.length;
      try {
        const page = parseCifraHtml(res.html, url);
        info.key = page.key;
        info.keyInferred = page.keyInferred;
        info.start = page.rawText.slice(0, 300);
      } catch (err) {
        info.parseError = String(err);
        info.htmlStart = res.html.slice(0, 300);
      }
      return info;
    })
  );
}

/** Diagnostic for /api/debug/cifra: what the direct fetch and the Serper
 * scrape return for a page, and what we extract from it. */
export async function debugCifra(url: string): Promise<Record<string, unknown>> {
  const direct = await fetchHtml(url);
  const out: Record<string, unknown> = {
    url,
    region: process.env.VERCEL_REGION ?? null,
    directStatus: direct.status,
    probes: await probeDirectVariants(url),
  };
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return { ...out, scrape: 'SERPER_API_KEY ausente' };
  const res = await fetch('https://scrape.serper.dev', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, includeMarkdown: true }),
  });
  out.scrapeStatus = res.status;
  const raw = await res.text();
  let data: SerperScrapeResponse = {};
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...out, scrapeBody: raw.slice(0, 2000) };
  }
  const markdown = data.markdown ?? '';
  const text = data.text ?? '';
  const around = (src: string) =>
    [...src.matchAll(/tom/gi)].slice(0, 5).map((m) => src.slice(Math.max(0, m.index! - 40), m.index! + 60));
  out.metadata = data.metadata;
  out.markdownLength = markdown.length;
  out.textLength = text.length;
  out.tomInMarkdown = around(markdown);
  out.tomInText = around(text);
  out.keyFound = findKey(text || markdown)?.[1] ?? null;
  try {
    const page = await scrapeCifra(url);
    out.parsed = { ...page, rawText: page.rawText.slice(0, 1500), chords: chordsIn(page.rawText) };
  } catch (err) {
    out.parseError = String(err);
  }
  out.markdownStart = markdown.slice(0, 1500);
  out.textStart = text.slice(0, 1500);
  return out;
}
