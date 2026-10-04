import type { SavedSong } from './store';

export interface SongSearchRequest {
  song: string;
  artist?: string;
}

export interface SongLookupResponse {
  /** Present when this result is an already-saved song (or matched one),
   * so the client can update it in place instead of creating a duplicate. */
  id?: string;
  chordpro: string;
  title: string;
  artist: string;
  key: string;
  /** Concrete key the user prefers to play this song in, when this result
   * is an already-saved song — see `SavedSong.preferredKey` in lib/store.ts. */
  preferredKey?: string;
  capo?: string;
  sourceUrl: string;
}

export interface SongSearchResponse {
  results: SongLookupResponse[];
  /** Set when the Cifra Club search failed but saved songs matched — the
   * results then hold only saved songs, and this explains why. */
  webSearchError?: string;
}

export interface ApiErrorResponse {
  error: string;
}

/** A setlist item with its `SavedSong` resolved alongside it — `song` is
 * `null` when the referenced song was deleted from "Minhas músicas" after
 * being added to the setlist. */
export interface ResolvedSetlistItem {
  songId: string;
  preferredKey: string;
  song: SavedSong | null;
}

export interface ResolvedSetlist {
  id: string;
  name: string;
  items: ResolvedSetlistItem[];
  createdAt: number;
}
