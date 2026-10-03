'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ResolvedSetlist, SongLookupResponse } from '@/lib/types';
import { parseChordProHeader } from '@/lib/chordpro';
import { songMatchScore, MATCH_THRESHOLD } from '@/lib/fuzzyMatch';
import type { Setlist, SavedSong } from '@/lib/store';
import ChordProView from './ChordProView';
import { useDampedTouchScroll } from './useDampedTouchScroll';

type Mode = 'search' | 'saved' | 'setlists';
type ViewMode = 'view' | 'code';

const KEY_OPTIONS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Espelha lib/store.ts DEFAULT_SETTINGS — usados como base do "100%" nos
// controles de tamanho de fonte (não importa DEFAULT_SETTINGS diretamente
// porque lib/store.ts puxa dependências server-only pro bundle do cliente).
const DEFAULT_LYRIC_FONT_SIZE = 0.9;
const DEFAULT_CHORD_FONT_SIZE = 1;
const DEFAULT_TAG_FONT_SIZE = 0.9;

/** Falls back to the first concrete key when the song's original/saved key
 * isn't one of the ones the preferred-key combo offers (e.g. a minor key). */
function normalizeKey(key: string | undefined): string {
  return key && KEY_OPTIONS.includes(key) ? key : KEY_OPTIONS[0];
}

/** Combo de tom editável, no mesmo visual do badge "Tom: X" — usado nas
 * listas compactas (lista de setlists e topo da tela de setlist aberto)
 * pra permitir trocar o tom sem precisar rolar até o bloco de acordes da
 * música. stopPropagation porque essas listas às vezes ficam dentro de um
 * card inteiro clicável (abre o setlist ao clicar em qualquer lugar). */
function renderTomSelect(
  value: string,
  originalKey: string | undefined,
  onChange: (k: string) => void
) {
  return (
    <label className="badge badge-tom badge-select" onClick={(e) => e.stopPropagation()}>
      Tom
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {KEY_OPTIONS.map((k) => {
          const isOriginal = k === originalKey;
          const isPreferred = k === value;
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
  );
}

/** Uma linha do sumário do setlist (título + tom) enquanto o modo "Ordenar"
 * está ligado — ganha a alcinha de arrastar e o X de remover; fora desse
 * modo a lista usa o <li> simples (título clicável rola até a música). */
function SortableTocRow({
  id,
  title,
  preferredKey,
  originalKey,
  onKeyChange,
  onRemove,
}: {
  id: string;
  title: string;
  preferredKey: string;
  originalKey: string | undefined;
  onKeyChange: (k: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <li
      ref={setNodeRef}
      className={isDragging ? 'setlist-toc-row dragging' : 'setlist-toc-row'}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="reorder-handle"
        aria-label="Arrastar"
        {...attributes}
        {...listeners}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" />
          <circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" />
          <circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <span className="setlist-toc-title-btn">{title}</span>
      {renderTomSelect(preferredKey, originalKey, onKeyChange)}
      <button type="button" className="reorder-remove" aria-label="Remover" onClick={onRemove}>
        ×
      </button>
    </li>
  );
}

interface ViewerMeta {
  id?: string;
  sourceUrl?: string;
}

// Client-side heuristic only, to decide which field to send — doesn't import
// lib/cifraclub.ts here since that pulls in server-only scraping deps. The
// API route re-validates with the real normalizeCifraUrl().
function looksLikeCifraUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return /(^|\.)cifraclub\.com\.br$/i.test(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

// Só troca o URL na barra de endereço (history.pushState) em vez de usar o
// router do Next — assim a navegação entre música/setlist/listas continua
// usando o estado local existente (instantânea, sem refetch), e o URL vira
// só um espelho pra permitir link direto/compartilhável. As rotas reais em
// app/song/[id] e app/setlist/[id] existem só pra resolver o load a frio.
function navigateTo(path: string) {
  if (window.location.pathname !== path) {
    window.history.pushState(null, '', path);
  }
}

export default function Home({
  initialSongId,
  initialSetlistId,
}: {
  initialSongId?: string;
  initialSetlistId?: string;
}) {
  useDampedTouchScroll();
  const [mode, setMode] = useState<Mode>('saved');
  const [song, setSong] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SongLookupResponse[] | null>(null);

  const [chordpro, setChordpro] = useState<string | null>(null);
  // Snapshot do texto ChordPro logo antes da última edição (digitação ou
  // atalho de inserção) — permite desfazer com um clique, sem depender do
  // undo nativo do navegador (que se comporta de forma inconsistente com
  // textarea controlado por React). Só um nível: desfaz só a última edição.
  const [undoSnapshot, setUndoSnapshot] = useState<string | null>(null);
  const codeTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Setlist de onde a música individual foi aberta via link "código" (ver
  // openSavedForCodeEdit) — se presente, o voltar (Visualização ou Código)
  // reabre esse setlist em vez de ir pra tela inicial.
  const [returnToSetlistId, setReturnToSetlistId] = useState<string | null>(null);
  const [viewerMeta, setViewerMeta] = useState<ViewerMeta>({});
  const [viewMode, setViewMode] = useState<ViewMode>('view');
  const [showGrau, setShowGrau] = useState(true);
  const [preferredKey, setPreferredKey] = useState<string>(KEY_OPTIONS[0]);
  const [showBeatMark, setShowBeatMark] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const navMenuRef = useRef<HTMLDivElement>(null);
  // Preferências gerais (menu Configurações) — persistem no banco (GET/PUT
  // /api/settings), não por música: são sobre COMO importar. Os defaults
  // aqui só valem até a primeira leitura do servidor completar.
  const [convertMinorToRelativeMajor, setConvertMinorToRelativeMajor] = useState(true);
  const [stripTablature, setStripTablature] = useState(false);
  const [lyricFontSize, setLyricFontSize] = useState(0.9);
  const [chordFontSize, setChordFontSize] = useState(1);
  const [tagFontSize, setTagFontSize] = useState(0.9);
  const [showSaveCopy, setShowSaveCopy] = useState(false);
  const [copyTitle, setCopyTitle] = useState('');
  const [copySaving, setCopySaving] = useState(false);

  const [savedSongs, setSavedSongs] = useState<SavedSong[] | null>(null);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [songSortMode, setSongSortMode] = useState<'alphabetical' | 'recent' | 'key'>('recent');
  const [songKeyFilter, setSongKeyFilter] = useState('');

  const [setlists, setSetlists] = useState<Setlist[] | null>(null);
  const [setlistsLoading, setSetlistsLoading] = useState(false);
  const [setlistsError, setSetlistsError] = useState<string | null>(null);

  const [creatingSetlist, setCreatingSetlist] = useState(false);
  const [setlistName, setSetlistName] = useState('');
  const [draftItems, setDraftItems] = useState<{ song: SavedSong; preferredKey: string }[]>([]);
  const [setlistSongQuery, setSetlistSongQuery] = useState('');
  const [setlistSearchResults, setSetlistSearchResults] = useState<SongLookupResponse[] | null>(
    null
  );
  const [setlistSearching, setSetlistSearching] = useState(false);
  const [setlistPickerError, setSetlistPickerError] = useState<string | null>(null);
  const [setlistAddingResult, setSetlistAddingResult] = useState<SongLookupResponse | null>(null);
  const [setlistAddedKeys, setSetlistAddedKeys] = useState<Set<string>>(new Set());
  const [savingSetlist, setSavingSetlist] = useState(false);
  const [setlistFormError, setSetlistFormError] = useState<string | null>(null);

  const [openSetlist, setOpenSetlist] = useState<ResolvedSetlist | null>(null);
  const [openSetlistError, setOpenSetlistError] = useState<string | null>(null);
  const [setlistGrau, setSetlistGrau] = useState(true);
  const [addingToSetlist, setAddingToSetlist] = useState(false);
  const [reorderingSetlist, setReorderingSetlist] = useState(false);
  const [setlistMenuOpen, setSetlistMenuOpen] = useState(false);
  const setlistMenuRef = useRef<HTMLDivElement>(null);
  const [expandedSetlistIds, setExpandedSetlistIds] = useState<Set<string>>(new Set());
  const setlistSongBlockRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const header = chordpro ? parseChordProHeader(chordpro) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMode('search');
    setLoading(true);
    setError(null);
    setResults(null);
    closeViewer();
    try {
      const body = {
        ...(looksLikeCifraUrl(song) ? { url: song } : { song }),
        convertMinorToRelativeMajor,
        stripTablature,
      };
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Erro ao buscar a música.');
        return;
      }
      const found = data.results as SongLookupResponse[];
      setResults(found);
      if (found.length === 1) openResult(found[0]);
    } catch {
      setError('Falha de rede ao buscar a música.');
    } finally {
      setLoading(false);
    }
  }

  // Fecha qualquer tela de setlist aberta — chamado sempre que uma música
  // individual é aberta (ex: via typeahead), já que as duas visualizações
  // não fazem sentido lado a lado.
  function closeSetlistUi() {
    setOpenSetlist(null);
    setOpenSetlistError(null);
    setCreatingSetlist(false);
    setAddingToSetlist(false);
    setReorderingSetlist(false);
    setSetlistMenuOpen(false);
    setSetlistSongQuery('');
    setSetlistSearchResults(null);
    setSetlistPickerError(null);
    setSetlistAddedKeys(new Set());
  }

  // Best-effort, mesma política do tom preferencial: marca o acesso agora
  // (server) e já reflete na lista local (otimista), sem esperar resposta.
  function touchSongAccess(id: string) {
    const now = Date.now();
    setSavedSongs(
      (list) => list?.map((s) => (s.id === id ? { ...s, lastAccessedAt: now } : s)) ?? null
    );
    fetch(`/api/songs/${id}/access`, { method: 'POST' }).catch(() => null);
  }

  function openResult(result: SongLookupResponse) {
    setChordpro(result.chordpro);
    setUndoSnapshot(null);
    setReturnToSetlistId(null);
    setViewerMeta({ id: result.id, sourceUrl: result.sourceUrl });
    setViewMode('view');
    setShowGrau(true);
    setPreferredKey(normalizeKey(result.preferredKey || result.key));
    setSaveMessage(null);
    setDirty(false);
    setMenuOpen(false);
    closeSetlistUi();
    if (result.id) touchSongAccess(result.id);
  }

  function openSaved(entry: SavedSong) {
    setChordpro(entry.chordpro);
    setUndoSnapshot(null);
    setReturnToSetlistId(null);
    setViewerMeta({ id: entry.id, sourceUrl: entry.sourceUrl });
    setViewMode('view');
    setShowGrau(true);
    setPreferredKey(normalizeKey(entry.preferredKey || entry.key));
    setSaveMessage(null);
    setDirty(false);
    setMenuOpen(false);
    closeSetlistUi();
    touchSongAccess(entry.id);
  }

  // Usado pelo link "código" na visualização de setlist — sai do setlist e
  // abre a música individual já no modo de edição do código ChordPro,
  // lembrando o setlist de origem pra "voltar" reabri-lo (ver
  // handleBackFromSong). openSaved já limpa o setlist aberto (closeSetlistUi)
  // — por isso o id é lido antes, e o novo estado setado depois dela.
  function openSavedForCodeEdit(entry: SavedSong) {
    const fromSetlistId = openSetlist?.id ?? null;
    openSaved(entry);
    setReturnToSetlistId(fromSetlistId);
    navigateTo(`/song/${entry.id}`);
    setViewMode('code');
  }

  function closeViewer() {
    setChordpro(null);
    setUndoSnapshot(null);
    setViewerMeta({});
    setShowGrau(true);
    setPreferredKey(KEY_OPTIONS[0]);
    setSaveMessage(null);
    setDirty(false);
    setMenuOpen(false);
    setReturnToSetlistId(null);
  }

  /** Voltar a partir da música individual: se ela foi aberta pelo link
   * "código" de dentro de um setlist (ver openSavedForCodeEdit), tanto o
   * voltar da Visualização quanto o do Código devem reabrir esse mesmo
   * setlist, em vez de ir pra tela inicial. */
  function handleBackFromSong() {
    const setlistId = returnToSetlistId;
    closeViewer();
    if (setlistId) {
      setMode('setlists');
      navigateTo(`/setlist/${setlistId}`);
      openSetlistById(setlistId);
    } else {
      navigateTo('/');
    }
  }

  async function handleLogout() {
    setNavMenuOpen(false);
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    window.location.href = '/login';
  }

  async function loadSongById(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/songs/${id}`);
      const data = await res.json();
      if (!res.ok || !data.song) return false;
      openSaved(data.song as SavedSong);
      return true;
    } catch {
      return false;
    }
  }

  // Abre direto a música/setlist do link (load a frio via /song/[id] ou
  // /setlist/[id]) assim que a tela monta.
  useEffect(() => {
    if (initialSongId) {
      loadSongById(initialSongId);
    } else if (initialSetlistId) {
      setMode('setlists');
      openSetlistById(initialSetlistId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Suporte a voltar/avançar do navegador entre as URLs que a própria app
  // empurra via navigateTo (não usa o router do Next — ver navigateTo acima).
  useEffect(() => {
    function handlePopState() {
      const path = window.location.pathname;
      const songMatch = path.match(/^\/song\/([^/]+)\/?$/);
      const setlistMatch = path.match(/^\/setlist\/([^/]+)\/?$/);
      if (songMatch) {
        loadSongById(decodeURIComponent(songMatch[1]));
      } else if (setlistMatch) {
        setMode('setlists');
        openSetlistById(decodeURIComponent(setlistMatch[1]));
      } else {
        closeViewer();
        closeSetlistUi();
      }
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDownload() {
    if (!chordpro || !header) return;
    const blob = new Blob([chordpro], { type: 'text/plain;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${header.artist || 'Artista'} - ${header.title || 'musica'}.cho`;
    a.click();
    URL.revokeObjectURL(downloadUrl);
  }

  /** Toda edição do código (digitação ou atalho) passa por aqui, pra sempre
   * guardar o valor anterior — é o que o botão "Desfazer" restaura. */
  function updateChordpro(next: string) {
    setUndoSnapshot(chordpro);
    setChordpro(next);
    setDirty(true);
    setSaveMessage(null);
  }

  function handleUndoEdit() {
    if (undoSnapshot === null) return;
    setChordpro(undoSnapshot);
    setUndoSnapshot(null);
    setDirty(true);
    setSaveMessage(null);
  }

  /** Botão de atalho "%": insere "[%]" (acorde "repete o anterior", notação
   * usada nas progressões instrumentais) na posição do cursor no textarea,
   * substituindo a seleção quando houver uma. */
  function insertPercentChord() {
    const el = codeTextareaRef.current;
    if (!el || chordpro === null) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const insertion = '[%]';
    updateChordpro(chordpro.slice(0, start) + insertion + chordpro.slice(end));
    const cursor = start + insertion.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }

  async function handleSave() {
    if (!chordpro || !header) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const endpoint = viewerMeta.id ? `/api/songs/${viewerMeta.id}` : '/api/songs';
      const method = viewerMeta.id ? 'PUT' : 'POST';
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: header.title || 'Sem título',
          artist: header.artist || '',
          key: header.key,
          preferredKey,
          capo: header.capo,
          sourceUrl: viewerMeta.sourceUrl,
          chordpro,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage(data.error || 'Erro ao salvar.');
        return;
      }
      setViewerMeta((m) => ({ ...m, id: data.song.id }));
      navigateTo(`/song/${data.song.id}`);
      setSaveMessage('Salvo!');
      setDirty(false);
      if (savedSongs) loadSavedSongs();
    } catch {
      setSaveMessage('Falha de rede ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  // Muda o tom preferencial imediatamente na tela e, se a música já estiver
  // salva, persiste em segundo plano — sem exigir um "Salvar" manual.
  async function handlePreferredKeyChange(newKey: string) {
    setPreferredKey(newKey);
    if (!chordpro || !header || !viewerMeta.id) return;
    try {
      await fetch(`/api/songs/${viewerMeta.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: header.title || 'Sem título',
          artist: header.artist || '',
          key: header.key,
          preferredKey: newKey,
          capo: header.capo,
          sourceUrl: viewerMeta.sourceUrl,
          chordpro,
        }),
      });
      if (savedSongs) loadSavedSongs();
    } catch {
      // Best-effort: a escolha já vale pra sessão atual mesmo se a
      // persistência falhar; o usuário pode tentar de novo depois.
    }
  }

  async function handleSaveCopy() {
    if (!chordpro || !header) return;
    const title = copyTitle.trim() || `${header.title || 'Sem título'}_copy`;
    setCopySaving(true);
    setSaveMessage(null);
    try {
      const titledChordpro = /^\s*\{title:[^}]*\}\s*$/im.test(chordpro)
        ? chordpro.replace(/^\s*\{title:[^}]*\}\s*$/im, `{title: ${title}}`)
        : chordpro;
      const res = await fetch('/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          artist: header.artist || '',
          key: header.key,
          preferredKey,
          capo: header.capo,
          sourceUrl: viewerMeta.sourceUrl,
          chordpro: titledChordpro,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage(data.error || 'Erro ao salvar cópia.');
        return;
      }
      setChordpro(titledChordpro);
      setUndoSnapshot(null);
      setViewerMeta((m) => ({ ...m, id: data.song.id }));
      navigateTo(`/song/${data.song.id}`);
      setSaveMessage('Cópia salva!');
      setShowSaveCopy(false);
      setMenuOpen(false);
      loadSavedSongs();
    } catch {
      setSaveMessage('Falha de rede ao salvar cópia.');
    } finally {
      setCopySaving(false);
    }
  }

  // Auto-save: while editing the raw ChordPro code, persist automatically a
  // moment after the user stops typing (creates the song on first edit if it
  // isn't saved yet, same as the manual save button).
  useEffect(() => {
    if (!dirty || viewMode !== 'code' || saving) return;
    const timer = setTimeout(() => {
      handleSave();
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chordpro, dirty, viewMode, saving]);

  async function loadSavedSongs() {
    setSavedLoading(true);
    setSavedError(null);
    try {
      const res = await fetch('/api/songs');
      const data = await res.json();
      if (!res.ok) {
        setSavedError(data.error || 'Erro ao carregar músicas salvas.');
        return;
      }
      setSavedSongs(data.songs as SavedSong[]);
    } catch {
      setSavedError('Falha de rede ao carregar músicas salvas.');
    } finally {
      setSavedLoading(false);
    }
  }

  const visibleSavedSongs = useMemo(() => {
    if (!savedSongs) return null;
    const filtered = songKeyFilter
      ? savedSongs.filter((s) => (s.preferredKey || s.key) === songKeyFilter)
      : savedSongs;
    const sorted = [...filtered];
    if (songSortMode === 'recent') {
      sorted.sort((a, b) => (b.lastAccessedAt ?? b.savedAt) - (a.lastAccessedAt ?? a.savedAt));
    } else if (songSortMode === 'key') {
      sorted.sort((a, b) => (a.preferredKey || a.key).localeCompare(b.preferredKey || b.key));
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    }
    return sorted;
  }, [savedSongs, songSortMode, songKeyFilter]);

  // Fecha o menu de opções da música ao clicar fora dele.
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Fecha o menu de navegação (Músicas/Setlists) ao clicar fora dele.
  useEffect(() => {
    if (!navMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (navMenuRef.current && !navMenuRef.current.contains(e.target as Node)) {
        setNavMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [navMenuOpen]);

  // Fecha o menu de configurações do setlist ao clicar fora dele.
  useEffect(() => {
    if (!setlistMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (setlistMenuRef.current && !setlistMenuRef.current.contains(e.target as Node)) {
        setSetlistMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [setlistMenuOpen]);

  // Fecha o formulário de "salvar cópia" junto com o menu.
  useEffect(() => {
    if (!menuOpen) setShowSaveCopy(false);
  }, [menuOpen]);

  // Carrega as músicas salvas assim que a tela abre (não só ao trocar de aba),
  // pra já ter dados disponíveis pro autocomplete enquanto o usuário digita.
  useEffect(() => {
    loadSavedSongs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lê as preferências de importação salvas no banco.
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        if (!data.settings) return;
        setConvertMinorToRelativeMajor(data.settings.convertMinorToRelativeMajor);
        setStripTablature(data.settings.stripTablature);
        setLyricFontSize(data.settings.lyricFontSize);
        setChordFontSize(data.settings.chordFontSize);
        setTagFontSize(data.settings.tagFontSize);
      })
      .catch(() => {
        // Sem banco configurado (ex: dev local) ou falha de rede — os
        // defaults locais já em uso continuam valendo pra sessão.
      });
  }, []);

  // Muda a preferência imediatamente na tela e persiste em segundo plano —
  // mesma política de melhor esforço do tom preferencial da música.
  async function updateSettings(patch: {
    convertMinorToRelativeMajor?: boolean;
    stripTablature?: boolean;
    lyricFontSize?: number;
    chordFontSize?: number;
    tagFontSize?: number;
  }) {
    const next = {
      convertMinorToRelativeMajor:
        patch.convertMinorToRelativeMajor ?? convertMinorToRelativeMajor,
      stripTablature: patch.stripTablature ?? stripTablature,
      lyricFontSize: patch.lyricFontSize ?? lyricFontSize,
      chordFontSize: patch.chordFontSize ?? chordFontSize,
      tagFontSize: patch.tagFontSize ?? tagFontSize,
    };
    setConvertMinorToRelativeMajor(next.convertMinorToRelativeMajor);
    setStripTablature(next.stripTablature);
    setLyricFontSize(next.lyricFontSize);
    setChordFontSize(next.chordFontSize);
    setTagFontSize(next.tagFontSize);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
    } catch {
      // ignorado — melhor esforço
    }
  }

  // Sugestões de músicas já salvas, calculadas ao vivo enquanto o usuário
  // digita (não precisa ser um match exato/completo).
  const typeaheadMatches = useMemo(() => {
    const query = song.trim();
    if (query.length < 2 || !savedSongs || results) return [];
    return savedSongs
      .map((s) => ({ s, score: songMatchScore(query, s.title, s.artist) }))
      .filter((m) => m.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((m) => m.s);
  }, [song, savedSongs, results]);

  function openTypeaheadMatch(entry: SavedSong) {
    setSong('');
    openSaved(entry);
    navigateTo(`/song/${entry.id}`);
  }

  // Sugestões ao vivo (músicas já salvas) enquanto o usuário digita no
  // buscador de músicas dentro do criador/editor de setlist — mesma lógica
  // do typeahead da busca principal, some assim que uma busca é disparada.
  const setlistTypeaheadMatches = useMemo(() => {
    const query = setlistSongQuery.trim();
    if (query.length < 2 || !savedSongs || setlistSearchResults) return [];
    return savedSongs
      .map((s) => ({ s, score: songMatchScore(query, s.title, s.artist) }))
      .filter((m) => m.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((m) => m.s);
  }, [setlistSongQuery, savedSongs, setlistSearchResults]);

  async function handleDeleteSaved(id: string) {
    await fetch(`/api/songs/${id}`, { method: 'DELETE' }).catch(() => null);
    setSavedSongs((list) => list?.filter((s) => s.id !== id) ?? null);
    if (viewerMeta.id === id) {
      closeViewer();
      navigateTo('/');
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setResults(null);
    closeViewer();
    closeSetlistUi();
    setNavMenuOpen(false);
    navigateTo('/');
    if (next === 'saved') loadSavedSongs();
    if (next === 'setlists') loadSetlists();
  }

  async function loadSetlists() {
    setSetlistsLoading(true);
    setSetlistsError(null);
    try {
      const res = await fetch('/api/setlists');
      const data = await res.json();
      if (!res.ok) {
        setSetlistsError(data.error || 'Erro ao carregar setlists.');
        return;
      }
      const sorted = [...(data.setlists as Setlist[])].sort((a, b) => b.createdAt - a.createdAt);
      setSetlists(sorted);
      // Primeira carga da tela: o mais recente já abre expandido. Não
      // reaplica em recargas seguintes, pra não desfazer o que o usuário
      // já expandiu/recolheu manualmente.
      if (setlists === null && sorted.length > 0) {
        setExpandedSetlistIds(new Set([sorted[0].id]));
      }
    } catch {
      setSetlistsError('Falha de rede ao carregar setlists.');
    } finally {
      setSetlistsLoading(false);
    }
  }

  function startCreatingSetlist() {
    setCreatingSetlist(true);
    setSetlistName('');
    setDraftItems([]);
    setSetlistSongQuery('');
    setSetlistSearchResults(null);
    setSetlistPickerError(null);
    setSetlistFormError(null);
    setSetlistAddedKeys(new Set());
  }

  function addDraftItem(s: SavedSong) {
    setDraftItems((items) => [...items, { song: s, preferredKey: s.preferredKey || s.key }]);
  }

  async function saveNewSetlist() {
    const name = setlistName.trim();
    if (!name || draftItems.length === 0) return;
    setSavingSetlist(true);
    setSetlistFormError(null);
    try {
      const res = await fetch('/api/setlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          items: draftItems.map((d) => ({ songId: d.song.id, preferredKey: d.preferredKey })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSetlistFormError(data.error || 'Erro ao salvar o setlist.');
        return;
      }
      setCreatingSetlist(false);
      loadSetlists();
    } catch {
      setSetlistFormError('Falha de rede ao salvar o setlist.');
    } finally {
      setSavingSetlist(false);
    }
  }

  async function handleDeleteSetlist(id: string) {
    await fetch(`/api/setlists/${id}`, { method: 'DELETE' }).catch(() => null);
    setSetlists((list) => list?.filter((c) => c.id !== id) ?? null);
    if (openSetlist?.id === id) {
      closeSetlistUi();
      navigateTo('/');
    }
  }

  // Rola até o card da música dentro do setlist aberto, ao clicar num item
  // da lista de músicas logo abaixo do título.
  function scrollToSetlistSong(index: number) {
    setlistSongBlockRefs.current.get(index)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toggleSetlistExpanded(id: string) {
    setExpandedSetlistIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function openSetlistById(id: string) {
    setOpenSetlistError(null);
    setSetlistGrau(true);
    setAddingToSetlist(false);
    try {
      const res = await fetch(`/api/setlists/${id}`);
      const data = await res.json();
      if (!res.ok) {
        setOpenSetlistError(data.error || 'Erro ao carregar o setlist.');
        return;
      }
      setOpenSetlist(data.setlist as ResolvedSetlist);
    } catch {
      setOpenSetlistError('Falha de rede ao carregar o setlist.');
    }
  }

  // Best-effort, mesma política do tom preferencial da música individual:
  // a mudança já vale na tela mesmo se a persistência falhar.
  async function persistSetlistItems(
    id: string,
    name: string,
    items: { songId: string; preferredKey: string }[]
  ) {
    try {
      await fetch(`/api/setlists/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          items: items.map((i) => ({ songId: i.songId, preferredKey: i.preferredKey })),
        }),
      });
    } catch {
      // ignorado — melhor esforço
    }
  }

  function addSongToOpenSetlist(s: SavedSong) {
    if (!openSetlist) return;
    const updatedItems = [
      ...openSetlist.items,
      { songId: s.id, preferredKey: s.preferredKey || s.key, song: s },
    ];
    setOpenSetlist({ ...openSetlist, items: updatedItems });
    persistSetlistItems(openSetlist.id, openSetlist.name, updatedItems);
  }

  function updateSetlistItemKey(index: number, newKey: string) {
    if (!openSetlist) return;
    const updatedItems = openSetlist.items.map((it, i) =>
      i === index ? { ...it, preferredKey: newKey } : it
    );
    setOpenSetlist({ ...openSetlist, items: updatedItems });
    persistSetlistItems(openSetlist.id, openSetlist.name, updatedItems);
  }

  function removeSetlistItem(index: number) {
    if (!openSetlist) return;
    const updatedItems = openSetlist.items.filter((_, i) => i !== index);
    setOpenSetlist({ ...openSetlist, items: updatedItems });
    persistSetlistItems(openSetlist.id, openSetlist.name, updatedItems);
  }

  const setlistTocSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
  );

  function handleSetlistTocDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!openSetlist || !over || active.id === over.id) return;
    const ids = openSetlist.items.map((item, i) => `${item.songId}::${i}`);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const updatedItems = arrayMove(openSetlist.items, oldIndex, newIndex);
    setOpenSetlist({ ...openSetlist, items: updatedItems });
    persistSetlistItems(openSetlist.id, openSetlist.name, updatedItems);
  }

  // Mesma ideia, mas pra editar o tom direto na lista de setlists (card
  // recolhido/expandido), sem precisar abrir o setlist.
  function updateSetlistListItemKey(setlistId: string, index: number, newKey: string) {
    if (!setlists) return;
    const target = setlists.find((s) => s.id === setlistId);
    if (!target) return;
    const updatedItems = target.items.map((it, i) =>
      i === index ? { ...it, preferredKey: newKey } : it
    );
    setSetlists(setlists.map((s) => (s.id === setlistId ? { ...s, items: updatedItems } : s)));
    persistSetlistItems(setlistId, target.name, updatedItems);
  }

  // Busca dentro do construtor de setlist (criação ou "adicionar música" num
  // setlist já aberto) — mesmo mecanismo da busca geral: músicas salvas +
  // resultados do Cifra Club (ver handleSubmit).
  async function searchSetlistSongs(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSetlistSearching(true);
    setSetlistPickerError(null);
    try {
      const body = {
        ...(looksLikeCifraUrl(trimmed) ? { url: trimmed } : { song: trimmed }),
        convertMinorToRelativeMajor,
        stripTablature,
      };
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSetlistPickerError(data.error || 'Erro ao buscar a música.');
        setSetlistSearchResults(null);
        return;
      }
      setSetlistSearchResults(data.results as SongLookupResponse[]);
    } catch {
      setSetlistPickerError('Falha de rede ao buscar a música.');
      setSetlistSearchResults(null);
    } finally {
      setSetlistSearching(false);
    }
  }

  // Adiciona um resultado da busca ao setlist — se ainda não estiver salva
  // (sem `id`), salva primeiro (mesmo payload de handleSave) antes de
  // adicionar, já que um item de setlist sempre referencia uma música salva.
  async function addSetlistSearchResult(
    result: SongLookupResponse,
    onAdd: (s: SavedSong) => void
  ) {
    setSetlistAddingResult(result);
    setSetlistPickerError(null);
    try {
      let song: SavedSong;
      if (result.id) {
        song = savedSongs?.find((s) => s.id === result.id) ?? {
          id: result.id,
          title: result.title,
          artist: result.artist,
          key: result.key,
          preferredKey: result.preferredKey,
          capo: result.capo,
          sourceUrl: result.sourceUrl,
          chordpro: result.chordpro,
          savedAt: Date.now(),
        };
      } else {
        const res = await fetch('/api/songs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: result.title,
            artist: result.artist,
            key: result.key,
            preferredKey: result.preferredKey,
            capo: result.capo,
            sourceUrl: result.sourceUrl,
            chordpro: result.chordpro,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setSetlistPickerError(data.error || 'Erro ao salvar a música.');
          return;
        }
        song = data.song as SavedSong;
        loadSavedSongs();
      }
      onAdd(song);
      setSetlistAddedKeys((prev) => new Set(prev).add(result.sourceUrl));
    } catch {
      setSetlistPickerError('Falha de rede ao salvar a música.');
    } finally {
      setSetlistAddingResult(null);
    }
  }

  function renderSetlistSongPicker(onAdd: (s: SavedSong) => void) {
    function selectTypeaheadMatch(s: SavedSong) {
      onAdd(s);
      if (s.sourceUrl) setSetlistAddedKeys((prev) => new Set(prev).add(s.sourceUrl!));
      setSetlistSongQuery('');
    }

    return (
      <div className="setlist-picker">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            searchSetlistSongs(setlistSongQuery);
          }}
        >
          <div className="search-input-wrap">
            <input
              placeholder="Música, artista + música, ou cole uma URL do Cifra Club"
              value={setlistSongQuery}
              onChange={(e) => setSetlistSongQuery(e.target.value)}
              autoComplete="off"
            />
            {setlistSongQuery && (
              <button
                type="button"
                className="clear-input-button"
                aria-label="Limpar"
                title="Limpar"
                onClick={() => setSetlistSongQuery('')}
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
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          <button type="submit" disabled={setlistSearching} aria-label="Buscar" title="Buscar">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </form>
        {setlistTypeaheadMatches.length > 0 && (
          <ul className="typeahead typeahead-inline">
            {setlistTypeaheadMatches.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="result-item"
                  onClick={() => selectTypeaheadMatch(s)}
                >
                  <span className="result-title">
                    {s.title} <span className="badge">Salva</span>
                  </span>
                  <span className="result-artist">{s.artist}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {setlistSearching && <p className="meta">Buscando…</p>}
        {setlistPickerError && <p className="error">{setlistPickerError}</p>}
        {setlistSearchResults &&
          !setlistSearching &&
          (setlistSearchResults.length === 0 ? (
            <p className="meta">Nenhuma música encontrada.</p>
          ) : (
            <ul className="results">
              {setlistSearchResults.map((r, i) => {
                const added = setlistAddedKeys.has(r.sourceUrl);
                return (
                  <li key={r.sourceUrl || `${r.title}-${i}`} className="saved-item">
                    <span className="result-item setlist-pick-row">
                      <span className="result-title">
                        {r.title} {r.id && <span className="badge">Salva</span>}
                      </span>
                      <span className="result-artist">
                        {r.artist}
                        {r.key ? ` · Tom: ${r.key}` : ''}
                        {r.capo ? ` · Capotraste: ${r.capo}ª casa` : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={added ? 'added' : undefined}
                      onClick={() => addSetlistSearchResult(r, onAdd)}
                      disabled={setlistAddingResult === r || added}
                    >
                      {setlistAddingResult === r ? (
                        'Adicionando…'
                      ) : added ? (
                        <>
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
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          Adicionado
                        </>
                      ) : (
                        'Adicionar'
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ))}
      </div>
    );
  }

  // A "primeira tela" é a busca em branco, sem nada ainda buscado/aberto —
  // o menu de navegação fica escondido só nela.
  /** Botão + dropdown do menu de navegação (hambúrguer) — extraído pra
   * função porque é renderizado em dois lugares diferentes: flutuando no
   * canto superior direito fora da música/setlist, ou alinhado dentro do
   * view-tabs (ao lado da engrenagem) quando uma música está aberta. */
  function renderNavMenuButton() {
    return (
      <>
          <button
            type="button"
            className="icon-button"
            aria-label="Navegação"
            title="Navegação"
            aria-haspopup="true"
            aria-expanded={navMenuOpen}
            onClick={() => setNavMenuOpen((v) => !v)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          {navMenuOpen && (
            <div className="menu-dropdown">
              <button
                type="button"
                className={mode === 'saved' ? 'menu-item-button active' : 'menu-item-button'}
                onClick={() => switchMode('saved')}
              >
                Músicas
              </button>
              <button
                type="button"
                className={mode === 'setlists' ? 'menu-item-button active' : 'menu-item-button'}
                onClick={() => switchMode('setlists')}
              >
                Setlists
              </button>

              <div className="menu-divider" />
              <p className="menu-section-title">Configurações</p>

              <label className="menu-toggle">
                Converter tom menor no relativo maior ao importar
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={convertMinorToRelativeMajor}
                    onChange={(e) =>
                      updateSettings({ convertMinorToRelativeMajor: e.target.checked })
                    }
                  />
                  <span className="switch-track" />
                </span>
              </label>
              <label className="menu-toggle">
                Eliminar tablaturas ao importar
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={stripTablature}
                    onChange={(e) => updateSettings({ stripTablature: e.target.checked })}
                  />
                  <span className="switch-track" />
                </span>
              </label>

              <div className="menu-font-control">
                Tamanho da fonte do texto da música
                <span className="menu-font-control-input">
                  <input
                    type="range"
                    min={0.6}
                    max={1.6}
                    step={0.05}
                    value={lyricFontSize}
                    onChange={(e) => updateSettings({ lyricFontSize: Number(e.target.value) })}
                    onDoubleClick={() => updateSettings({ lyricFontSize: DEFAULT_LYRIC_FONT_SIZE })}
                    aria-label="Tamanho da fonte do texto da música"
                    title="Duplo clique para restaurar 100%"
                  />
                  <span className="menu-font-control-value">
                    {Math.round((lyricFontSize / DEFAULT_LYRIC_FONT_SIZE) * 100)}%
                  </span>
                </span>
              </div>
              <div className="menu-font-control">
                Tamanho da fonte da cifra
                <span className="menu-font-control-input">
                  <input
                    type="range"
                    min={0.6}
                    max={1.6}
                    step={0.05}
                    value={chordFontSize}
                    onChange={(e) => updateSettings({ chordFontSize: Number(e.target.value) })}
                    onDoubleClick={() => updateSettings({ chordFontSize: DEFAULT_CHORD_FONT_SIZE })}
                    aria-label="Tamanho da fonte da cifra"
                    title="Duplo clique para restaurar 100%"
                  />
                  <span className="menu-font-control-value">
                    {Math.round((chordFontSize / DEFAULT_CHORD_FONT_SIZE) * 100)}%
                  </span>
                </span>
              </div>
              <div className="menu-font-control">
                Tamanho da fonte da tag
                <span className="menu-font-control-input">
                  <input
                    type="range"
                    min={0.6}
                    max={1.6}
                    step={0.05}
                    value={tagFontSize}
                    onChange={(e) => updateSettings({ tagFontSize: Number(e.target.value) })}
                    onDoubleClick={() => updateSettings({ tagFontSize: DEFAULT_TAG_FONT_SIZE })}
                    aria-label="Tamanho da fonte da tag"
                    title="Duplo clique para restaurar 100%"
                  />
                  <span className="menu-font-control-value">
                    {Math.round((tagFontSize / DEFAULT_TAG_FONT_SIZE) * 100)}%
                  </span>
                </span>
              </div>
              <button
                type="button"
                className="menu-item-button"
                disabled={!chordpro && !openSetlist}
                title={
                  !chordpro && !openSetlist
                    ? 'Abra uma música ou um setlist para gerar o PDF'
                    : undefined
                }
                onClick={() => {
                  setNavMenuOpen(false);
                  window.print();
                }}
              >
                <svg
                  className="menu-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9V2h12v7" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect x="6" y="14" width="12" height="8" />
                </svg>
                Gerar PDF
              </button>

              <div className="menu-divider" />
              <button type="button" className="menu-item-button" onClick={handleLogout}>
                Sair
              </button>
            </div>
          )}
      </>
    );
  }

  const isHomeScreen = mode === 'search' && !chordpro && !results;

  const isCodeEditing = Boolean(chordpro && header && viewMode === 'code');

  return (
    <main className={isCodeEditing ? 'code-editing' : undefined}>
      {!isHomeScreen && !(chordpro && header) && (
        <div className="nav-menu-wrap" ref={navMenuRef}>
          {renderNavMenuButton()}
        </div>
      )}

      {!chordpro && <h1>CifraX</h1>}

      {/* Tela de edição de código: sem barra de busca nem botão de voltar —
          fica um espaço só de edição; pra sair da música, troca pra
          Visualização (que tem o botão de voltar de volta). */}
      {!(chordpro && viewMode === 'code') && (
      <div className="search-field">
        <form onSubmit={handleSubmit}>
          {(chordpro || openSetlist) && (
            <button
              type="button"
              className="secondary back-button"
              onClick={() => {
                if (chordpro) handleBackFromSong();
                else {
                  closeSetlistUi();
                  navigateTo('/');
                }
              }}
              aria-label="Voltar"
              title="Voltar"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <div className="search-input-wrap">
            <input
              placeholder="Música, artista + música, ou cole uma URL do Cifra Club"
              value={song}
              onChange={(e) => setSong(e.target.value)}
              autoComplete="off"
              required
            />
            {song && (
              <button
                type="button"
                className="clear-input-button"
                aria-label="Limpar"
                title="Limpar"
                onClick={() => setSong('')}
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
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          <button type="submit" disabled={loading} aria-label="Buscar" title="Buscar">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </form>
        {loading && <p className="meta">Buscando…</p>}

        {typeaheadMatches.length > 0 && (
          <ul className="typeahead">
            {typeaheadMatches.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="result-item"
                  onClick={() => openTypeaheadMatch(s)}
                >
                  <span className="result-title">
                    {s.title} <span className="badge">Salva</span>
                  </span>
                  <span className="result-artist">{s.artist}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      )}

      {!openSetlist && (
        <div className={chordpro && viewMode === 'code' ? 'view-tabs view-tabs-sticky' : 'view-tabs'}>
          {chordpro && header && (
            <>
            {viewMode === 'code' && (
              <button
                type="button"
                className="secondary back-button"
                onClick={handleBackFromSong}
                aria-label="Voltar"
                title="Voltar"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className={viewMode === 'view' ? 'tab active' : 'tab'}
              onClick={() => setViewMode('view')}
              aria-label="Visualização"
              title="Visualização"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </button>
            <button
              type="button"
              className={viewMode === 'code' ? 'tab active' : 'tab'}
              onClick={() => setViewMode('code')}
              aria-label="Código ChordPro"
              title="Código ChordPro"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M10.478 1.647a.5.5 0 1 0-.956-.294l-4 13a.5.5 0 0 0 .956.294l4-13zM4.854 4.146a.5.5 0 0 1 0 .708L1.707 8l3.147 3.146a.5.5 0 0 1-.708.708l-3.5-3.5a.5.5 0 0 1 0-.708l3.5-3.5a.5.5 0 0 1 .708 0zm6.292 0a.5.5 0 0 0 0 .708L14.293 8l-3.147 3.146a.5.5 0 0 0 .708.708l3.5-3.5a.5.5 0 0 0 0-.708l-3.5-3.5a.5.5 0 0 0-.708 0z" />
              </svg>
            </button>

            {viewMode === 'code' && (
              <>
                <button
                  type="button"
                  className="icon-button"
                  title="Inserir [%] (repete o acorde anterior)"
                  aria-label="Inserir [%]"
                  onClick={insertPercentChord}
                >
                  %
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Desfazer última edição"
                  aria-label="Desfazer última edição"
                  disabled={undoSnapshot === null}
                  onClick={handleUndoEdit}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 14 4 9l5-5" />
                    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                  </svg>
                </button>
              </>
            )}

            {!viewerMeta.id && (
              <button onClick={handleSave} disabled={saving}>
                {saving ? 'Salvando…' : 'Salvar música'}
              </button>
            )}

            {saveMessage && <span className="save-message">{saveMessage}</span>}

          </>
        )}

        {!chordpro && (
          <>
            <button
              type="button"
              className={mode === 'saved' ? 'tab active' : 'tab'}
              onClick={() => switchMode('saved')}
            >
              Músicas
            </button>
            <button
              type="button"
              className={mode === 'setlists' ? 'tab active' : 'tab'}
              onClick={() => switchMode('setlists')}
            >
              Setlists
            </button>
          </>
        )}

        {chordpro && header && (
            <div className="menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="tab"
                aria-label="Configurações"
                title="Configurações"
                aria-haspopup="true"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>

              {menuOpen && (
                <div className="menu-dropdown">
                  <label className="menu-toggle">
                    <svg
                      className="menu-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="4" y1="9" x2="20" y2="9" />
                      <line x1="4" y1="15" x2="20" y2="15" />
                      <line x1="10" y1="3" x2="8" y2="21" />
                      <line x1="16" y1="3" x2="14" y2="21" />
                    </svg>
                    Grau
                    <span className="switch">
                      <input
                        type="checkbox"
                        checked={showGrau}
                        onChange={(e) => setShowGrau(e.target.checked)}
                      />
                      <span className="switch-track" />
                    </span>
                  </label>
                  <label className="menu-toggle">
                    <svg
                      className="menu-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <polyline points="12 7 12 12 15 14" />
                    </svg>
                    Compasso
                    <span className="switch">
                      <input
                        type="checkbox"
                        checked={showBeatMark}
                        onChange={(e) => setShowBeatMark(e.target.checked)}
                      />
                      <span className="switch-track" />
                    </span>
                  </label>
                  <button
                    type="button"
                    className="menu-item-button"
                    onClick={() => {
                      handleDownload();
                      setMenuOpen(false);
                    }}
                  >
                    <svg
                      className="menu-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 3v12" />
                      <polyline points="7 10 12 15 17 10" />
                      <path d="M5 21h14" />
                    </svg>
                    Baixar .cho
                  </button>
                  {showSaveCopy ? (
                    <div className="save-copy-form">
                      <input
                        type="text"
                        value={copyTitle}
                        onChange={(e) => setCopyTitle(e.target.value)}
                        autoFocus
                      />
                      <button type="button" onClick={handleSaveCopy} disabled={copySaving}>
                        {copySaving ? 'Salvando…' : 'Salvar'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="menu-item-button"
                      onClick={() => {
                        setCopyTitle(`${header.title || 'Sem título'}_copy`);
                        setShowSaveCopy(true);
                      }}
                    >
                      <svg
                        className="menu-icon"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
                      </svg>
                      Salvar cópia
                    </button>
                  )}
                  {viewerMeta.id && (
                    <button
                      type="button"
                      className="menu-item-button danger"
                      onClick={() => {
                        handleDeleteSaved(viewerMeta.id!);
                        setMenuOpen(false);
                      }}
                    >
                      <svg
                        className="menu-icon"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                      Apagar
                    </button>
                  )}
                </div>
              )}
            </div>
        )}

        {chordpro && header && (
          <div className="menu-wrap menu-wrap-adjacent" ref={navMenuRef}>
            {renderNavMenuButton()}
          </div>
        )}
        </div>
      )}

      {mode === 'search' && error && <p className="error">{error}</p>}

      {mode === 'search' && results && results.length > 1 && !chordpro && (
        <ul className="results">
          {results.map((r) => (
            <li key={r.sourceUrl}>
              <button
                className="result-item"
                onClick={() => {
                  openResult(r);
                  if (r.id) navigateTo(`/song/${r.id}`);
                }}
              >
                <span className="result-title">
                  {r.title} {r.id && <span className="badge">Salva</span>}
                </span>
                <span className="result-artist">
                  {r.artist}
                  {r.key ? ` · Tom: ${r.key}` : ''}
                  {r.capo ? ` · Capotraste: ${r.capo}ª casa` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {mode === 'saved' && !chordpro && (
        <>
          {savedSongs && savedSongs.length > 0 && (
            <div className="song-list-toolbar">
              <label className="toolbar-select">
                Ordenar
                <select
                  value={songSortMode}
                  onChange={(e) =>
                    setSongSortMode(e.target.value as 'alphabetical' | 'recent' | 'key')
                  }
                >
                  <option value="alphabetical">Alfabética</option>
                  <option value="recent">Recentes</option>
                  <option value="key">Tom</option>
                </select>
              </label>
              <label className="toolbar-select">
                Tom
                <select value={songKeyFilter} onChange={(e) => setSongKeyFilter(e.target.value)}>
                  <option value="">Todos</option>
                  {KEY_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {savedLoading && <p className="meta">Carregando…</p>}
          {savedError && <p className="error">{savedError}</p>}
          {savedSongs && savedSongs.length === 0 && !savedLoading && (
            <p className="meta">Nenhuma música salva ainda.</p>
          )}
          {visibleSavedSongs && visibleSavedSongs.length === 0 && savedSongs && savedSongs.length > 0 && (
            <p className="meta">Nenhuma música salva nesse tom.</p>
          )}
          {visibleSavedSongs && visibleSavedSongs.length > 0 && (
            <ul className="results">
              {visibleSavedSongs.map((s) => (
                <li key={s.id} className="saved-item">
                  <button
                    className="result-item"
                    onClick={() => {
                      openSaved(s);
                      navigateTo(`/song/${s.id}`);
                    }}
                  >
                    <span className="result-title">{s.title}</span>
                    <span className="badge badge-tom">Tom: {s.preferredKey || s.key}</span>
                    <span className="result-artist">{s.artist}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {mode === 'setlists' && !chordpro && !openSetlist && !creatingSetlist && (
        <>
          <div className="actions setlist-list-actions">
            <button type="button" onClick={startCreatingSetlist}>
              + Criar setlist
            </button>
          </div>
          {setlistsLoading && <p className="meta">Carregando…</p>}
          {setlistsError && <p className="error">{setlistsError}</p>}
          {setlists && setlists.length === 0 && !setlistsLoading && (
            <p className="meta">Nenhum setlist criado ainda.</p>
          )}
          {setlists && setlists.length > 0 && (
            <ul className="results">
              {setlists.map((c) => {
                const expanded = expandedSetlistIds.has(c.id);
                return (
                  <li
                    key={c.id}
                    className="result-item setlist-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      openSetlistById(c.id);
                      navigateTo(`/setlist/${c.id}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openSetlistById(c.id);
                        navigateTo(`/setlist/${c.id}`);
                      }
                    }}
                  >
                    <span className="setlist-card-open">
                      <span className="result-title">
                        {c.name}{' '}
                        <span className="badge">
                          {c.items.length} {c.items.length === 1 ? 'música' : 'músicas'}
                        </span>
                      </span>
                    </span>
                    {expanded && (
                      <ul className="setlist-expanded-list">
                        {c.items.map((item, i) => {
                          const song = savedSongs?.find((s) => s.id === item.songId);
                          return (
                            <li key={i}>
                              <span>{song?.title || 'Música removida'}</span>
                              {renderTomSelect(item.preferredKey, song?.key, (k) =>
                                updateSetlistListItemKey(c.id, i, k)
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <button
                      type="button"
                      className={expanded ? 'icon-button setlist-expand-toggle expanded' : 'icon-button setlist-expand-toggle'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSetlistExpanded(c.id);
                      }}
                      aria-label={expanded ? 'Recolher' : 'Expandir'}
                      title={expanded ? 'Recolher' : 'Expandir'}
                      aria-expanded={expanded}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {mode === 'setlists' && !chordpro && creatingSetlist && (
        <div className="setlist-builder">
          <button
            type="button"
            className="back-button"
            onClick={() => setCreatingSetlist(false)}
            aria-label="Voltar"
            title="Voltar"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <label className="setlist-name-field">
            Nome do setlist
            <input
              value={setlistName}
              onChange={(e) => setSetlistName(e.target.value)}
              placeholder="ex: culto 02/08/26"
            />
          </label>

          {renderSetlistSongPicker(addDraftItem)}

          <p className="meta">Músicas no setlist ({draftItems.length})</p>
          {draftItems.length === 0 ? (
            <p className="meta">Nenhuma música adicionada ainda.</p>
          ) : (
            <ul className="results">
              {draftItems.map((d, i) => (
                <li key={`${d.song.id}-${i}`} className="saved-item">
                  <span className="result-item setlist-pick-row">
                    <span className="result-title">
                      {i + 1}. {d.song.title}
                    </span>
                    <span className="badge badge-tom">{d.preferredKey}</span>
                  </span>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => setDraftItems((items) => items.filter((_, j) => j !== i))}
                    aria-label="Remover"
                    title="Remover"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {setlistFormError && <p className="error">{setlistFormError}</p>}

          <div className="actions">
            <button
              type="button"
              onClick={saveNewSetlist}
              disabled={savingSetlist || !setlistName.trim() || draftItems.length === 0}
            >
              {savingSetlist ? 'Salvando…' : 'Salvar setlist'}
            </button>
          </div>
        </div>
      )}

      {mode === 'setlists' && !chordpro && openSetlist && (
        <div className="setlist-view">
          <div className="setlist-view-header">
            <h2 className="setlist-view-name">{openSetlist.name}</h2>
            <button
              type="button"
              className={reorderingSetlist ? 'icon-button active' : 'icon-button'}
              aria-label="Ordenar"
              title="Ordenar"
              aria-pressed={reorderingSetlist}
              onClick={() => {
                setReorderingSetlist((v) => !v);
                setAddingToSetlist(false);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M11.5 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L11 2.707V14.5a.5.5 0 0 0 .5.5zm-7-14a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L4 13.293V1.5a.5.5 0 0 1 .5-.5z"
                />
              </svg>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Adicionar música"
              title="Adicionar música"
              onClick={() => {
                setAddingToSetlist((v) => !v);
                setReorderingSetlist(false);
                setSetlistSongQuery('');
                setSetlistSearchResults(null);
                setSetlistPickerError(null);
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <div className="menu-wrap" ref={setlistMenuRef}>
              <button
                type="button"
                className="tab"
                aria-label="Configurações"
                title="Configurações"
                aria-haspopup="true"
                aria-expanded={setlistMenuOpen}
                onClick={() => setSetlistMenuOpen((v) => !v)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>

              {setlistMenuOpen && (
                <div className="menu-dropdown">
                  <label className="menu-toggle">
                    <svg
                      className="menu-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="4" y1="9" x2="20" y2="9" />
                      <line x1="4" y1="15" x2="20" y2="15" />
                      <line x1="10" y1="3" x2="8" y2="21" />
                      <line x1="16" y1="3" x2="14" y2="21" />
                    </svg>
                    Grau
                    <span className="switch">
                      <input
                        type="checkbox"
                        checked={setlistGrau}
                        onChange={(e) => setSetlistGrau(e.target.checked)}
                      />
                      <span className="switch-track" />
                    </span>
                  </label>
                  <button
                    type="button"
                    className="menu-item-button danger"
                    onClick={() => {
                      handleDeleteSetlist(openSetlist.id);
                      setSetlistMenuOpen(false);
                    }}
                  >
                    <svg
                      className="menu-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                    Excluir setlist
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="print-area">
          <h2 className="setlist-print-title">{openSetlist.name}</h2>
          {openSetlist.items.length > 0 &&
            (reorderingSetlist ? (
              <DndContext
                sensors={setlistTocSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleSetlistTocDragEnd}
              >
                <SortableContext
                  items={openSetlist.items.map((item, i) => `${item.songId}::${i}`)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul className="setlist-expanded-list setlist-toc">
                    {openSetlist.items.map((item, i) => (
                      <SortableTocRow
                        key={`${item.songId}::${i}`}
                        id={`${item.songId}::${i}`}
                        title={item.song?.title || 'Música removida'}
                        preferredKey={item.preferredKey}
                        originalKey={item.song?.key}
                        onKeyChange={(k) => updateSetlistItemKey(i, k)}
                        onRemove={() => removeSetlistItem(i)}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            ) : (
              <ul className="setlist-expanded-list setlist-toc">
                {openSetlist.items.map((item, i) => (
                  <li key={`${item.songId}-${i}`}>
                    <button
                      type="button"
                      className="setlist-toc-title-btn"
                      onClick={() => scrollToSetlistSong(i)}
                    >
                      {item.song?.title || 'Música removida'}
                    </button>
                    {renderTomSelect(item.preferredKey, item.song?.key ?? undefined, (k) =>
                      updateSetlistItemKey(i, k)
                    )}
                  </li>
                ))}
              </ul>
            ))}

          {addingToSetlist && (
            <div className="setlist-add-panel">
              <div className="setlist-add-panel-header">
                <h3>Adicionar música</h3>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Fechar"
                  title="Fechar"
                  onClick={() => setAddingToSetlist(false)}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              {renderSetlistSongPicker(addSongToOpenSetlist)}
            </div>
          )}

          {openSetlistError && <p className="error">{openSetlistError}</p>}

            {openSetlist.items.length === 0 ? (
              <p className="meta">Nenhuma música neste setlist ainda — toque em Adicionar.</p>
            ) : (
              openSetlist.items.map((item, i) => (
                <div
                  key={`${item.songId}-${i}`}
                  className="setlist-song-block"
                  ref={(el) => {
                    if (el) setlistSongBlockRefs.current.set(i, el);
                    else setlistSongBlockRefs.current.delete(i);
                  }}
                >
                  {item.song ? (
                    <ChordProView
                      text={item.song.chordpro}
                      viewKey={setlistGrau ? 'graus' : item.preferredKey}
                      preferredKey={item.preferredKey}
                      sourceUrl={item.song.sourceUrl}
                      showBeatMark={showBeatMark}
                      showArtist={false}
                      lyricFontSize={lyricFontSize}
                      chordFontSize={chordFontSize}
                      tagFontSize={tagFontSize}
                      keySelect={{
                        options: KEY_OPTIONS,
                        originalKey: item.song.key,
                        onChange: (k) => updateSetlistItemKey(i, k),
                      }}
                      onEditCode={() => openSavedForCodeEdit(item.song!)}
                    />
                  ) : (
                    <div className="chordpro-view">
                      <p className="meta">Música removida</p>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {chordpro &&
        header &&
        (viewMode === 'code' ? (
          <>
            <textarea
              ref={codeTextareaRef}
              value={chordpro}
              onChange={(e) => updateChordpro(e.target.value)}
            />
            {/* Mesmos atalhos do topo, duplicados aqui embaixo — depois de
                rolar um código longo, a barra de cima fica longe do
                polegar; esses dois usam o mesmo textarea/handlers. */}
            <div className="code-toolbar-bottom">
              <button
                type="button"
                className="icon-button"
                title="Inserir [%] (repete o acorde anterior)"
                aria-label="Inserir [%]"
                onClick={insertPercentChord}
              >
                %
              </button>
              <button
                type="button"
                className="icon-button"
                title="Desfazer última edição"
                aria-label="Desfazer última edição"
                disabled={undoSnapshot === null}
                onClick={handleUndoEdit}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 14 4 9l5-5" />
                  <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                </svg>
              </button>
            </div>
          </>
        ) : (
          <ChordProView
            text={chordpro}
            viewKey={showGrau ? 'graus' : preferredKey}
            preferredKey={preferredKey}
            sourceUrl={viewerMeta.sourceUrl}
            showBeatMark={showBeatMark}
            lyricFontSize={lyricFontSize}
            chordFontSize={chordFontSize}
            tagFontSize={tagFontSize}
            keySelect={{
              options: KEY_OPTIONS,
              originalKey: header.key,
              onChange: handlePreferredKeyChange,
            }}
          />
        ))}

      {/* Sempre no DOM (independente da aba Visualização/Código aberta na
          tela), só visível ao imprimir/gerar PDF — ver .print-only no CSS. */}
      {chordpro && header && (
        <div className="print-area print-only">
          <ChordProView
            text={chordpro}
            viewKey={showGrau ? 'graus' : preferredKey}
            preferredKey={preferredKey}
            sourceUrl={viewerMeta.sourceUrl}
            showBeatMark={showBeatMark}
            lyricFontSize={lyricFontSize}
            chordFontSize={chordFontSize}
            tagFontSize={tagFontSize}
          />
        </div>
      )}

      <footer className="disclaimer">
        Uso pessoal/educacional. Letras e cifras pertencem aos respectivos autores e ao Cifra
        Club — respeite os direitos autorais ao compartilhar os arquivos gerados.
      </footer>
    </main>
  );
}
