'use client';

import { useEffect, useState } from 'react';
import {
  ANNOTATION_NEWLINE,
  parseChordProBody,
  parseChordProHeader,
  type ChordProChunk,
} from '@/lib/chordpro';
import { nashvilleToChord } from '@/lib/transpose';

const NBSP = ' ';

export type ViewKey = 'graus' | string;

/** {Refrão}, {Refrão 2}, {Refrão final}... viram um destaque amarelo,
 * {Pré-Refrão}/{Pré Refrão}... um destaque laranja, e {Ponte}/{Ponte 2}...
 * um destaque rosa, separados dos outros marcadores de seção (cinza), pra
 * achar esses trechos de relance na hora de tocar. A checagem de
 * "pré-refrão" precisa vir antes da de "refrão" pura, já que o rótulo
 * contém a palavra "refrão" dentro dele. */
function tagClassName(label: string): string {
  if (/pr[eé]\s*-?\s*refr[aã]o/i.test(label)) return 'chunk-tag chunk-tag-prechorus';
  if (/refr[aã]o/i.test(label)) return 'chunk-tag chunk-tag-chorus';
  if (/ponte/i.test(label)) return 'chunk-tag chunk-tag-bridge';
  return 'chunk-tag';
}

type BodyLine = ReturnType<typeof parseChordProBody>[number];

function hasTagChunk(line: BodyLine): boolean {
  return line.type === 'chords' && line.chunks.some((c) => c.kind === 'tag');
}

/** Para cada linha, se ela fica escondida por estar numa seção recolhida —
 * da linha seguinte à da {tag} até antes da próxima linha com tag. As
 * linhas em branco no fim da seção continuam visíveis, pra manter o
 * espaçamento entre a tag recolhida e a seção seguinte. */
function hiddenLines(lines: BodyLine[], collapsed: Set<number>): boolean[] {
  const hidden = lines.map(() => false);
  for (const start of collapsed) {
    if (!lines[start] || !hasTagChunk(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && !hasTagChunk(lines[end])) end++;
    let last = end - 1;
    while (last > start && lines[last].type === 'blank') last--;
    for (let k = start + 1; k <= last; k++) hidden[k] = true;
  }
  return hidden;
}

type AnnotationSegment ={ text: string; isAnnotation: boolean };

/** Splits a string on `<...>` spans, e.g. "Ei <suave> agora" ->
 * ["Ei ", {annotation: "suave"}, " agora"] — used to render performance
 * notes in a muted, slightly smaller style within any lyric/text line. */
function splitAnnotations(str: string): AnnotationSegment[] {
  return str
    .split(/(<[^>]*>)/g)
    .filter((part) => part !== '')
    .map((part) => {
      const m = part.match(/^<([^>]*)>$/);
      return m ? { text: m[1], isAnnotation: true } : { text: part, isAnnotation: false };
    });
}

/** Renders a line/chunk's text, wrapping any `<nota>` annotation in a muted
 * span. When `highlightFirstTwo` is set, also underlines the first two
 * letters of the leading plain segment as the chord's beat mark — skipped
 * when the text starts with an annotation, since there's no syllable there
 * to mark. */
interface WordPiece {
  chunk: ChordProChunk;
  index: number;
  /** The slice of the chunk's lyric in this piece. */
  lyric: string;
  /** First piece of its chunk — the one the chord sits on. */
  first: boolean;
  /** Where `lyric` starts in the line's lyric text (tags count as 1 char) —
   * see capsMask. */
  offset: number;
}

/** Groups a line's chunks into whole words, so the line only wraps between
 * words when it overflows the frame — never inside a word that has a chord
 * in the middle ("desesper[4]ados"). Each chunk's lyric is split after its
 * whitespace runs; a `<nota>` stays in one piece. */
function toWordUnits(chunks: ChordProChunk[]): WordPiece[][] {
  const units: WordPiece[][] = [];
  let current: WordPiece[] = [];
  let offset = 0;
  const close = () => {
    if (current.length) units.push(current);
    current = [];
  };
  chunks.forEach((chunk, index) => {
    if (chunk.kind === 'tag') {
      close();
      units.push([{ chunk, index, lyric: '', first: true, offset }]);
      offset += 1;
      return;
    }
    const pieces = chunk.lyric.match(/(?:<[^>]*>|\S)*\s*/g)?.filter(Boolean) ?? [];
    if (pieces.length === 0) pieces.push('');
    // Acorde sobre um espaço ("[2m] Teu"): o espaço sozinho é mais estreito
    // que o acorde e a coluna abriria um vão — junta com a palavra seguinte.
    if (chunk.chord !== null && pieces.length > 1 && pieces[0].trim() === '') {
      pieces.splice(0, 2, pieces[0] + pieces[1]);
    }
    pieces.forEach((lyric, k) => {
      current.push({ chunk, index, lyric, first: k === 0, offset });
      offset += lyric.length;
      if (/\s$/.test(lyric)) close();
    });
  });
  close();
  return units;
}

/** Pedaços da letra: números e palavras (o resto, como espaços e pontuação,
 * fica entre eles). */
const LYRIC_TOKEN = /(\d+)|([\p{L}'’_-]+)/gu;

function isAllCaps(word: string): boolean {
  return /\p{Lu}/u.test(word) && word === word.toLocaleUpperCase('pt-BR');
}

/** Quais caracteres da letra são "texto em caixa alta" (laranja): palavras
 * de 2+ letras em maiúsculas, e letras soltas maiúsculas ao lado de outra
 * palavra maiúscula ("A TUA", "É O"), pra um "A" ou "É" de começo de frase
 * não ficar laranja à toa. Calculado na linha inteira (ver chords-line), já que a tela desenha
 * cada palavra separada. */
function capsMask(text: string): boolean[] {
  const mask: boolean[] = new Array(text.length).fill(false);
  const words = [...text.matchAll(LYRIC_TOKEN)].filter((m) => !m[1]);
  const caps = (m: RegExpMatchArray | undefined) => !!m && isAllCaps(m[0]);
  words.forEach((m, i) => {
    const long = m[0].replace(/[^\p{L}]/gu, '').length >= 2;
    if (caps(m) && (long || caps(words[i - 1]) || caps(words[i + 1]))) {
      mask.fill(true, m.index!, m.index! + m[0].length);
    }
  });
  return mask;
}

/** Letra com destaques: qualquer número ("3te", "se3rá") em cinza claro e o
 * texto em caixa alta (ver capsMask) em laranja. `mask` vem da linha
 * inteira quando o trecho é parte dela. */
function renderLyricText(
  text: string,
  highlightFirstTwo = false,
  mask: boolean[] = capsMask(text)
): React.ReactNode {
  const styled: { text: string; cls: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(LYRIC_TOKEN)) {
    if (m.index! > last) styled.push({ text: text.slice(last, m.index), cls: '' });
    styled.push({
      text: m[0],
      cls: m[1] ? 'lyric-count' : mask[m.index!] ? 'lyric-caps' : '',
    });
    last = m.index! + m[0].length;
  }
  if (last < text.length) styled.push({ text: text.slice(last), cls: '' });
  const render = (parts: typeof styled) =>
    parts.map((p, i) =>
      p.cls ? (
        <span key={i} className={p.cls}>
          {p.text}
        </span>
      ) : (
        p.text
      )
    );
  if (!highlightFirstTwo) return render(styled);

  // Marca de tempo nos 2 primeiros caracteres — cortada depois de classificar
  // o trecho inteiro, pra "TUA" não virar "TU" + "A" na hora de decidir a cor.
  const head: typeof styled = [];
  const tail: typeof styled = [];
  let left = 2;
  for (const p of styled) {
    if (left <= 0) tail.push(p);
    else if (p.text.length <= left) {
      head.push(p);
      left -= p.text.length;
    } else {
      head.push({ ...p, text: p.text.slice(0, left) });
      tail.push({ ...p, text: p.text.slice(left) });
      left = 0;
    }
  }
  return (
    <>
      <span className="chunk-lyric-highlight">{render(head)}</span>
      {render(tail)}
    </>
  );
}

function renderAnnotated(
  str: string,
  highlightFirstTwo: boolean,
  mask: boolean[] = capsMask(str)
): React.ReactNode {
  // Posição de cada pedaço em `str` (as anotações perdem o "<" e ">").
  let pos = 0;
  return splitAnnotations(str).map((seg, k) => {
    const from = pos + (seg.isAnnotation ? 1 : 0);
    pos += seg.text.length + (seg.isAnnotation ? 2 : 0);
    const segMask = mask.slice(from, from + seg.text.length);
    if (seg.isAnnotation) {
      const lines = seg.text.split(ANNOTATION_NEWLINE);
      return (
        <span key={k} className="view-annotation">
          {lines.map((l, li) => (
            <span key={li}>
              {li > 0 && <br />}
              {l}
            </span>
          ))}
        </span>
      );
    }
    if (highlightFirstTwo && k === 0) {
      return (
        <span key={k}>
          {renderLyricText(seg.text, true, segMask)}
        </span>
      );
    }
    return <span key={k}>{renderLyricText(seg.text, false, segMask)}</span>;
  });
}

interface KeySelect {
  options: string[];
  /** Highlighted em vermelho no combo, pra distinguir do `preferredKey`
   * (destacado em azul) — ver Discovery/setlists.md. */
  originalKey?: string;
  onChange: (key: string) => void;
}

export default function ChordProView({
  text,
  viewKey,
  preferredKey,
  sourceUrl,
  showBeatMark = true,
  showArtist = true,
  lyricFontSize,
  chordFontSize,
  tagFontSize,
  keySelect,
  onEditCode,
  onEditText,
  onScrollToTop,
  grauToggle,
  songCollapse,
}: {
  text: string;
  viewKey: ViewKey;
  preferredKey: string;
  sourceUrl?: string;
  showBeatMark?: boolean;
  /** false na visualização de setlist, pra manter cada card enxuto — a
   * música individual continua mostrando o artista normalmente. */
  showArtist?: boolean;
  /** Tamanho da fonte do texto da música (letra), em rem — configurável
   * no menu Configurações (ver Settings em lib/store.ts). */
  lyricFontSize?: number;
  /** Tamanho da fonte da cifra (acordes), em rem — mesmo mecanismo. */
  chordFontSize?: number;
  /** Tamanho da fonte das tags de seção ({Refrão}, {Ponte}, etc.), em rem —
   * mesmo mecanismo. */
  tagFontSize?: number;
  /** Quando presente, o badge de tom vira um `<select>` editável (usado na
   * visualização de setlist, onde o tom por música pode ser ajustado
   * direto na tela) — sem isso, o badge é só texto (música individual). */
  keySelect?: KeySelect;
  /** Quando presente, mostra um link "Editar código" ao lado do link do
   * Cifra Club, que abre a música individual já no modo de código ChordPro
   * (usado na visualização de setlist — a música individual já tem sua
   * própria aba de código, então não precisa deste link). */
  onEditCode?: () => void;
  /** Quando presente, mostra um lápis antes do ícone de código, que edita a
   * letra direto na apresentação (usado na visualização de setlist). */
  onEditText?: () => void;
  /** Quando presente, mostra um botão "topo" no fim da música que rola a
   * tela até o início dela (usado na visualização de setlist). */
  onScrollToTop?: () => void;
  /** Quando presente, mostra uma caixa "grau" ao lado de "código": marcada,
   * a música aparece em graus; desmarcada, em cifras no tom escolhido
   * (usado na visualização de setlist, por música). */
  grauToggle?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Quando presente, o título vira um botão que recolhe/expande a música:
   * recolhida, só o título aparece (usado na visualização de setlist). */
  songCollapse?: { collapsed: boolean; onToggle: () => void };
}) {
  const header = parseChordProHeader(text);
  const lines = parseChordProBody(text);
  // Seções recolhidas, pelo índice da linha que tem a {tag}. Zera quando o
  // texto muda, já que os índices deixam de bater com as linhas.
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  useEffect(() => setCollapsed(new Set()), [text]);
  const hidden = hiddenLines(lines, collapsed);

  function toggleSection(lineIndex: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(lineIndex)) next.delete(lineIndex);
      else next.add(lineIndex);
      return next;
    });
  }

  /** Só a primeira tag da linha ganha a seta e o clique — a seção é da
   * linha, não de cada tag. */
  function renderTag(label: string, lineIndex: number, isToggle: boolean, extraClass = '') {
    const className = `${extraClass}${tagClassName(label)}`;
    // data-section-tag / data-chord marcam o DOM pra quem precisa achar
    // seções e cifras na tela (ver scrollToSetlistSongStart em HomeShell).
    // Uma tag com a progressão embutida ("Intro - 1 | 4") conta como cifra.
    const marks = {
      'data-section-tag': label,
      ...(label.includes('|') ? { 'data-chord': '' } : {}),
    };
    if (!isToggle) {
      return (
        <span className={className} {...marks}>
          {label}
        </span>
      );
    }
    const isCollapsed = collapsed.has(lineIndex);
    return (
      <button
        type="button"
        {...marks}
        className={`${className} chunk-tag-toggle`}
        aria-expanded={!isCollapsed}
        title={isCollapsed ? 'Expandir seção' : 'Recolher seção'}
        onClick={() => toggleSection(lineIndex)}
      >
        <span className="chunk-tag-chevron" aria-hidden="true">
          {isCollapsed ? '▸' : '▾'}
        </span>
        {label}
      </button>
    );
  }
  const fontVars = {
    ...(lyricFontSize != null ? { '--lyric-font-size': `${lyricFontSize}rem` } : {}),
    ...(chordFontSize != null ? { '--chord-font-size': `${chordFontSize}rem` } : {}),
    ...(tagFontSize != null ? { '--tag-font-size': `${tagFontSize}rem` } : {}),
  } as React.CSSProperties;

  function displayChord(chord: string): string {
    const clean = chord.endsWith('.') ? chord.slice(0, -1) : chord;
    if (viewKey === 'graus') return clean;
    try {
      return nashvilleToChord(clean, viewKey);
    } catch {
      return clean;
    }
  }

  const title = header.title || 'Sem título';
  if (songCollapse?.collapsed) {
    return (
      // O card recolhido inteiro expande a música ao toque, não só o título.
      <div
        className="chordpro-view chordpro-view-collapsed"
        style={fontVars}
        role="button"
        tabIndex={0}
        aria-expanded={false}
        onClick={songCollapse.onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            songCollapse.onToggle();
          }
        }}
      >
        <h2 className="view-title">
          <span className="view-title-toggle">
            <span className="chunk-tag-chevron" aria-hidden="true">▸</span>
            {title}
          </span>
        </h2>
      </div>
    );
  }

  return (
    <div className="chordpro-view" style={fontVars}>
      <h2 className="view-title">
        {songCollapse ? (
          <button type="button" className="view-title-toggle" onClick={songCollapse.onToggle} aria-expanded>
            <span className="chunk-tag-chevron" aria-hidden="true">▾</span>
            {title}
          </button>
        ) : (
          title
        )}
      </h2>
      <p className="view-artist">
        {keySelect ? (
          <label className="badge badge-tom badge-select">
            Tom
            <select value={preferredKey} onChange={(e) => keySelect.onChange(e.target.value)}>
              {keySelect.options.map((k) => {
                const isOriginal = k === keySelect.originalKey;
                const isPreferred = k === preferredKey;
                return (
                  <option
                    key={k}
                    value={k}
                    style={{
                      color: isPreferred ? '#4f9dff' : isOriginal ? '#ff6b6b' : undefined,
                      fontWeight: isPreferred || isOriginal ? 700 : undefined,
                    }}
                  >
                    {k}
                    {isOriginal && !isPreferred ? ' (original)' : ''}
                  </option>
                );
              })}
            </select>
          </label>
        ) : (
          <span className="badge badge-tom">Tom: {preferredKey}</span>
        )}
        {showArtist && header.artist && (
          <span className="view-artist-name">{header.artist}</span>
        )}
        {sourceUrl && (
          <a className="source-link" href={sourceUrl} target="_blank" rel="noreferrer">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            cifraclub
          </a>
        )}
        {onEditText && (
          <button
            type="button"
            className="source-link source-link-icon"
            onClick={onEditText}
            aria-label="Editar letra"
            title="Editar letra"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            </svg>
          </button>
        )}
        {onEditCode && (
          <button
            type="button"
            className="source-link source-link-icon"
            onClick={onEditCode}
            aria-label="Código ChordPro"
            title="Código ChordPro"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.478 1.647a.5.5 0 1 0-.956-.294l-4 13a.5.5 0 0 0 .956.294l4-13zM4.854 4.146a.5.5 0 0 1 0 .708L1.707 8l3.147 3.146a.5.5 0 0 1-.708.708l-3.5-3.5a.5.5 0 0 1 0-.708l3.5-3.5a.5.5 0 0 1 .708 0zm6.292 0a.5.5 0 0 0 0 .708L14.293 8l-3.147 3.146a.5.5 0 0 0 .708.708l3.5-3.5a.5.5 0 0 0 0-.708l-3.5-3.5a.5.5 0 0 0-.708 0z" />
            </svg>
          </button>
        )}
        {grauToggle && (
          <label className="source-link source-toggle">
            <input
              type="checkbox"
              checked={grauToggle.checked}
              onChange={(e) => grauToggle.onChange(e.target.checked)}
            />
            grau
          </label>
        )}
      </p>
      {header.originalMinorKey && (
        <p className="key-disclaimer">
          A música original é em tom menor {header.originalMinorKey} e foi apresentada em{' '}
          {header.key} como grau 1.
        </p>
      )}
      {header.capo && (
        <p className="view-badges">
          <span className="badge">Capotraste: {header.capo}ª casa</span>
        </p>
      )}
      <div className="view-body">
        {lines.map((line, i) => {
          if (hidden[i]) return null;
          if (line.type === 'blank') return <div key={i} className="view-blank" />;
          if (line.type === 'text') {
            return (
              <p key={i} className="view-line">
                {renderAnnotated(line.text, false)}
              </p>
            );
          }
          // Uma linha que só tem {tag} + acorde(s) sem letra (ex: "{Verso 1}
          // [1 | 4 | 1 | 47M]") não é um par "acorde em cima da sílaba" — é
          // rótulo + progressão. Empilhar em duas linhas (o layout normal de
          // chord-over-lyric) faria o rótulo e a progressão parecerem
          // desalinhados; aqui os dois ficam lado a lado, na mesma linha.
          const hasTag = line.chunks.some((c) => c.kind === 'tag');
          const firstTag = line.chunks.findIndex((c) => c.kind === 'tag');
          const hasRealLyric = line.chunks.some((c) => c.kind === 'chord' && c.lyric.trim() !== '');
          if (hasTag && !hasRealLyric) {
            return (
              <p key={i} className="view-line">
                {line.chunks
                  .filter((c) => c.kind === 'tag' || c.chord !== null)
                  .map((chunk, j, shown) => (
                    <span key={j}>
                      {j > 0 && '  '}
                      {chunk.kind === 'tag' ? (
                        renderTag(chunk.label, i, shown.findIndex((c) => c.kind === 'tag') === j)
                      ) : (
                        <span
                          className={
                            chunk.chord!.includes('|')
                              ? 'chunk-chord chunk-chord-plain'
                              : 'chunk-chord'
                          }
                          data-chord=""
                        >
                          {displayChord(chunk.chord!)}
                        </span>
                      )}
                    </span>
                  ))}
              </p>
            );
          }
          // Caixa alta decidida na linha inteira, com as palavras que um
          // acorde divide ("DA[5]NÇAREMOS") juntas; tag conta como 1 espaço.
          const lineCaps = capsMask(
            line.chunks.map((c) => (c.kind === 'tag' ? ' ' : c.lyric)).join('')
          );
          return (
            <div key={i} className="view-line chords-line">
              {toWordUnits(line.chunks).map((unit, u) => (
                <span className="chunk-word" key={u}>
                  {unit.map(({ chunk, index: j, lyric, first, offset }, k) =>
                    chunk.kind === 'tag' ? (
                      <span className="chunk" key={k}>
                        <span className="chunk-chord">{NBSP}</span>
                        {renderTag(chunk.label, i, j === firstTag, 'chunk-lyric ')}
                      </span>
                    ) : (
                      <span className="chunk" key={k}>
                        <span
                          className={
                            first && chunk.chord !== null && chunk.chord.includes('|')
                              ? 'chunk-chord chunk-chord-plain'
                              : 'chunk-chord'
                          }
                          data-chord={first && chunk.chord !== null ? '' : undefined}
                        >
                          {first && chunk.chord !== null ? displayChord(chunk.chord) : NBSP}
                        </span>
                        <span className="chunk-lyric">
                          {lyric
                            ? renderAnnotated(
                                lyric,
                                first &&
                                  chunk.chord !== null &&
                                  showBeatMark &&
                                  !chunk.chord.endsWith('.') &&
                                  !chunk.chord.includes('|'),
                                lineCaps.slice(offset, offset + lyric.length)
                              )
                            : NBSP}
                        </span>
                      </span>
                    )
                  )}
                </span>
              ))}
            </div>
          );
        })}
      </div>
      {onScrollToTop && (
        <p className="view-footer">
          <button type="button" className="source-link" onClick={onScrollToTop}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
            topo
          </button>
        </p>
      )}
    </div>
  );
}
