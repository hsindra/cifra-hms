'use client';

import { parseChordProHeader } from '@/lib/chordpro';
import { nashvilleToChord } from '@/lib/transpose';

const DIRECTIVE_LINE = /^\s*\{\w+:.*\}\s*$/;
const NBSP = ' ';

type Piece =
  | { kind: 'text'; seg: number; chord: string | null }
  | { kind: 'tag'; label: string };

/** Splits one ChordPro line into its source segments — text, `[chord]` and
 * `{tag}` alternate — and pairs each text segment with the chord right
 * before it. `seg` is the text's index in the segment list, so an edit maps
 * back to exactly that piece of the line. */
function linePieces(segments: string[]): Piece[] {
  const pieces: Piece[] = [];
  let pendingChord: string | null = null;
  segments.forEach((seg, i) => {
    if (seg.startsWith('[') && seg.endsWith(']')) {
      if (pendingChord !== null) pieces.push({ kind: 'text', seg: -1, chord: pendingChord });
      pendingChord = seg.slice(1, -1);
    } else if (seg.startsWith('{') && seg.endsWith('}')) {
      if (pendingChord !== null) pieces.push({ kind: 'text', seg: -1, chord: pendingChord });
      pendingChord = null;
      pieces.push({ kind: 'tag', label: seg.slice(1, -1) });
    } else if (seg !== '' || pendingChord !== null) {
      pieces.push({ kind: 'text', seg: i, chord: pendingChord });
      pendingChord = null;
    }
  });
  if (pendingChord !== null) pieces.push({ kind: 'text', seg: -1, chord: pendingChord });
  return pieces;
}

/**
 * Edição da letra direto na apresentação: mostra a música como na
 * visualização (acordes em cima, letra embaixo), mas cada trecho de letra é
 * editável. Ao sair de um trecho, só aquele pedaço da linha muda no código
 * ChordPro — acordes, tags e cabeçalho ficam como estão (pra mexer neles,
 * o editor de código).
 */
export default function ChordProEditView({
  text,
  viewKey,
  onChange,
  onDone,
}: {
  text: string;
  /** 'graus' ou um tom concreto — só muda como os acordes aparecem. */
  viewKey: string;
  onChange: (next: string) => void;
  /** Quando presente, mostra um botão "Concluir" que sai da edição. */
  onDone?: () => void;
}) {
  const header = parseChordProHeader(text);
  const lines = text.split('\n');

  function displayChord(chord: string): string {
    const clean = chord.endsWith('.') ? chord.slice(0, -1) : chord;
    if (viewKey === 'graus' || clean.includes('|')) return clean;
    try {
      return nashvilleToChord(clean, viewKey);
    } catch {
      return clean;
    }
  }

  function commit(lineIndex: number, segments: string[], seg: number, value: string) {
    if (segments[seg] === value) return;
    const nextSegments = [...segments];
    nextSegments[seg] = value;
    const nextLines = [...lines];
    nextLines[lineIndex] = nextSegments.join('');
    onChange(nextLines.join('\n'));
  }

  return (
    <div className="chordpro-view chordpro-edit-view">
      <h2 className="view-title">{header.title || 'Sem título'}</h2>
      <p className="meta chordpro-edit-hint">
        Toque num trecho da letra para editar. Acordes e tags: use o código.
        {onDone && (
          <button type="button" className="source-link chordpro-edit-done" onClick={onDone}>
            Concluir
          </button>
        )}
      </p>
      <div className="view-body">
        {lines.map((line, i) => {
          if (DIRECTIVE_LINE.test(line)) return null;
          if (line.trim() === '') return <div key={i} className="view-blank" />;
          const segments = line.split(/(\[[^\]]*\]|\{[^}]*\})/);
          return (
            <div key={i} className="view-line chords-line">
              {linePieces(segments).map((piece, j) =>
                piece.kind === 'tag' ? (
                  <span className="chunk" key={j}>
                    <span className="chunk-chord">{NBSP}</span>
                    <span className="chunk-lyric chunk-tag">{piece.label}</span>
                  </span>
                ) : (
                  <span className="chunk" key={j}>
                    <span
                      className={
                        piece.chord?.includes('|') ? 'chunk-chord chunk-chord-plain' : 'chunk-chord'
                      }
                    >
                      {piece.chord !== null ? displayChord(piece.chord) : NBSP}
                    </span>
                    {piece.seg >= 0 ? (
                      <span
                        // A key muda com o texto: depois de salvar, o trecho
                        // remonta com o valor novo em vez de brigar com o React.
                        key={`${i}-${piece.seg}-${segments[piece.seg]}`}
                        className="chunk-lyric chunk-editable"
                        contentEditable
                        suppressContentEditableWarning
                        spellCheck={false}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLElement).blur();
                          }
                        }}
                        onBlur={(e) =>
                          commit(i, segments, piece.seg, (e.target as HTMLElement).textContent ?? '')
                        }
                      >
                        {segments[piece.seg]}
                      </span>
                    ) : (
                      <span className="chunk-lyric">{NBSP}</span>
                    )}
                  </span>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
