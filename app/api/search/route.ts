import { NextRequest, NextResponse } from 'next/server';
import {
  searchCifra,
  fetchCifra,
  normalizeCifraUrl,
  CifraAccessError,
  CifraNotFoundError,
  SearchConfigError,
} from '@/lib/cifraclub';
import { buildChordPro, convertChordProToNashville, removeTablature } from '@/lib/chordpro';
import { isMinorKey, relativeMajorKey } from '@/lib/transpose';
import { listSongs, type SavedSong } from '@/lib/store';
import { songMatchScore, MATCH_THRESHOLD } from '@/lib/fuzzyMatch';
import type { CifraPage } from '@/lib/cifraclub';
import type { SongLookupResponse, SongSearchResponse } from '@/lib/types';

/** Thrown when a cifra page didn't expose a detectable "Tom:" — without a key
 * there's no safe way to convert its chords into graus, so it can't be
 * returned (see Discovery/cifras-em-graus.md). */
class MissingKeyError extends Error {
  constructor() {
    super('Não foi possível identificar o tom desta cifra, então não é possível salvá-la em graus.');
  }
}

function savedToResult(s: SavedSong): SongLookupResponse {
  return {
    id: s.id,
    chordpro: s.chordpro,
    title: s.title,
    artist: s.artist,
    key: s.key,
    preferredKey: s.preferredKey,
    capo: s.capo,
    sourceUrl: s.sourceUrl ?? '',
  };
}

interface ImportSettings {
  convertMinorToRelativeMajor: boolean;
  stripTablature: boolean;
}

function toSongResult(c: CifraPage, settings: ImportSettings): SongLookupResponse {
  if (!c.key) throw new MissingKeyError();
  // Músicas detectadas em tom menor são reapresentadas no relativo maior
  // (grau 1 = tônica do maior) — ver relativeMajorKey em lib/transpose.ts e
  // o disclaimer renderizado em ChordProView a partir de originalMinorKey.
  // Comportamento opcional, controlado pelo toggle em Configurações.
  const originalMinorKey =
    settings.convertMinorToRelativeMajor && isMinorKey(c.key) ? c.key : undefined;
  const effectiveKey = originalMinorKey ? relativeMajorKey(originalMinorKey) : c.key;
  const rawText = settings.stripTablature ? removeTablature(c.rawText) : c.rawText;
  const chordproConcrete = buildChordPro(
    {
      title: c.title,
      artist: c.artist,
      key: effectiveKey,
      originalMinorKey,
      capo: c.capo,
      sourceUrl: c.sourceUrl,
    },
    rawText
  );
  return {
    chordpro: convertChordProToNashville(chordproConcrete, effectiveKey),
    title: c.title,
    artist: c.artist,
    key: effectiveKey,
    capo: c.capo,
    sourceUrl: c.sourceUrl,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
  // Preferências gerais do usuário (menu Configurações) — default preserva o
  // comportamento atual (converter tom menor ligado, tablatura preservada)
  // quando o cliente não manda os campos.
  const settings: ImportSettings = {
    convertMinorToRelativeMajor: body?.convertMinorToRelativeMajor !== false,
    stripTablature: body?.stripTablature === true,
  };

  try {
    if (rawUrl) {
      const url = normalizeCifraUrl(rawUrl);
      if (!url) {
        return NextResponse.json(
          { error: 'Essa URL não parece ser do Cifra Club (cifraclub.com.br).' },
          { status: 400 }
        );
      }
      const page = await fetchCifra(url);
      const response: SongSearchResponse = { results: [toSongResult(page, settings)] };
      return NextResponse.json(response);
    }

    const song = typeof body?.song === 'string' ? body.song.trim() : '';
    const artist = typeof body?.artist === 'string' ? body.artist.trim() : '';
    if (!song) {
      return NextResponse.json({ error: 'Informe ao menos o nome da música.' }, { status: 400 });
    }

    const [saved, webSearch] = await Promise.all([
      listSongs().catch(() => [] as SavedSong[]), // busca não deve quebrar se o KV não estiver configurado
      searchCifra(artist, song).then(
        (candidates) => ({ ok: true as const, candidates }),
        (error) => ({ ok: false as const, error })
      ),
    ]);

    const query = [artist, song].filter(Boolean).join(' ');
    const savedMatches = saved
      .map((s) => ({ s, score: songMatchScore(query, s.title, s.artist) }))
      .filter((m) => m.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.s);
    const savedUrls = new Set(savedMatches.map((s) => s.sourceUrl).filter(Boolean));

    const results: SongLookupResponse[] = savedMatches.map(savedToResult);
    let webSearchError: string | undefined;

    if (!webSearch.ok) {
      // Sem músicas salvas pra mostrar, o erro da busca na internet é o único
      // resultado possível — propaga. Com salvas, elas vão como resposta, mas
      // o erro segue junto pra UI avisar que o Cifra Club não foi consultado.
      if (results.length === 0) throw webSearch.error;
      const e = webSearch.error;
      webSearchError = e instanceof Error ? e.message : 'Erro ao buscar no Cifra Club.';
    } else {
      for (const c of webSearch.candidates) {
        if (c.sourceUrl && savedUrls.has(c.sourceUrl)) continue; // já apareceu como salva
        try {
          results.push(toSongResult(c, settings));
        } catch (err) {
          if (err instanceof MissingKeyError) continue; // sem tom, não dá pra salvar em graus
          throw err;
        }
      }
    }

    const response: SongSearchResponse = { results, webSearchError };
    return NextResponse.json(response);
  } catch (err) {
    if (err instanceof MissingKeyError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof CifraNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof SearchConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof CifraAccessError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : 'Erro inesperado ao buscar a cifra.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
