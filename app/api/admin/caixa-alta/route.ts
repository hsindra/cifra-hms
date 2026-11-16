import { NextRequest, NextResponse } from 'next/server';
import { listSongs, saveSong, type SavedSong } from '@/lib/store';
import { uppercaseSectionStarts } from '@/lib/chordpro';
import { songMatchScore } from '@/lib/fuzzyMatch';

// Administração (protegida pelo login do middleware): aplica nas músicas já
// salvas a regra de caixa alta nas duas primeiras palavras de cada parte.
//   ?busca=santo espirito laura  → mostra a prévia (não altera nada)
//   ?busca=...&aplicar=1         → grava, se a busca achar exatamente 1 música
//   ?id=<id>[&aplicar=1]         → mesma coisa, por id
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const busca = params.get('busca')?.trim() ?? '';
  const id = params.get('id')?.trim() ?? '';
  const aplicar = params.get('aplicar') === '1';
  if (!busca && !id) {
    return NextResponse.json({ error: 'Passe ?busca=<título e artista> ou ?id=<id>' }, { status: 400 });
  }

  const songs = await listSongs();
  const matches = id
    ? songs.filter((s) => s.id === id)
    : songs.filter((s) => songMatchScore(busca, s.title, s.artist) === 1);
  if (matches.length !== 1) {
    return NextResponse.json({
      error:
        matches.length === 0
          ? 'Nenhuma música encontrada.'
          : 'Mais de uma música encontrada — refine a busca ou use ?id=.',
      encontradas: matches.map((s) => ({ id: s.id, title: s.title, artist: s.artist })),
    });
  }

  const song: SavedSong = matches[0];
  const updated = uppercaseSectionStarts(song.chordpro);
  const before = song.chordpro.split('\n');
  const after = updated.split('\n');
  const mudancas = after
    .map((line, i) => ({ antes: before[i], depois: line }))
    .filter((c) => c.antes !== c.depois);

  if (aplicar && mudancas.length > 0) {
    await saveSong({ ...song, chordpro: updated });
  }
  return NextResponse.json({
    musica: { id: song.id, title: song.title, artist: song.artist },
    aplicado: aplicar && mudancas.length > 0,
    mudancas,
  });
}
