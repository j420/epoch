'use client';

/**
 * Local persistence for a visitor's own photograph.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: the photograph never leaves the device
 * except for the single `/api/photo/identify` call, and it is not stored on any
 * server or in any database. It is a stranger's photograph and we have no
 * consent to keep it. So it lives here, in IndexedDB, on their phone, and it
 * goes away when they clear it or clear their browser data.
 *
 * The depth map is NOT stored here. `lib/depth.ts` already caches it in its own
 * `bol-depth` database, keyed by a hash of the hero bytes — and because our hero
 * is a stable blob, that key is stable across reloads too. Duplicating it would
 * mean two copies of the same megabyte and two chances to drift out of sync.
 *
 * Every operation resolves rather than rejects. Private-mode Safari throws from
 * `indexedDB.open` synchronously and some Android WebViews have no IndexedDB at
 * all; on those devices the feature still works perfectly for the length of the
 * session, it just forgets on reload. Losing persistence must never lose the
 * photograph in front of the visitor.
 */

import type { Region } from '@/lib/types';
import type { DepthSource } from '@/lib/depth';

const DB_NAME = 'bol-photo';
const DB_VERSION = 1;
const STORE = 'photos';

/** More than this and we start evicting the oldest — a phone is not an archive. */
const MAX_KEPT = 6;

export interface StoredPhoto {
  /** Content hash of the JPEG bytes. Primary key, and the monument id suffix. */
  hash: string;
  /** The downscaled JPEG itself. Never uploaded anywhere but /api/photo/identify. */
  blob: Blob;
  width: number;
  height: number;
  aspect: number;
  /** Vision's guess. Used only to offer the real monument — never spoken. */
  identifiedAs: string | null;
  /** Sanitised, visual-only. The only context the answering model receives. */
  description: string;
  looksLike: string[];
  matchedMonumentId: string | null;
  confidence: 'high' | 'low';
  regions: Region[];
  depthSource: DepthSource;
  createdAt: number;
}

function available(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase | null> {
  if (!available()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Private-mode Safari throws synchronously here.
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'hash' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** FNV-1a over every 7th byte. The fallback when `crypto.subtle` is unavailable. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 7) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv${h.toString(16)}-${bytes.length.toString(16)}`;
}

/**
 * A content hash of the photograph.
 *
 * Content-addressed on purpose: the visitor who reloads, or who picks the same
 * file twice, lands on the same key and the depth model does not run again.
 * `crypto.subtle` is unavailable on a non-secure origin, which is exactly where
 * a demo laptop tends to be, so the FNV fallback is a real path and not
 * defensive decoration.
 */
export async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = Array.from(new Uint8Array(digest).slice(0, 10))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `sha${hex}`;
    } catch {
      /* non-secure context: subtle exists but rejects */
    }
  }
  return fnv1a(new Uint8Array(buf));
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, resolve: (v: T) => void) => void, fallback: T): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve) => {
        if (!db) return resolve(fallback);
        let settled = false;
        const done = (v: T) => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        try {
          const t = db.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          run(store, done);
          t.oncomplete = () => {
            db.close();
            done(fallback);
          };
          t.onerror = () => done(fallback);
          t.onabort = () => done(fallback);
        } catch {
          done(fallback);
        }
      }),
  );
}

export async function savePhoto(record: StoredPhoto): Promise<void> {
  await tx<void>('readwrite', (store) => {
    store.put(record);
  }, undefined);
  await evictOldest();
}

export function loadPhoto(hash: string): Promise<StoredPhoto | null> {
  return tx<StoredPhoto | null>(
    'readonly',
    (store, resolve) => {
      const req = store.get(hash);
      req.onsuccess = () => resolve((req.result as StoredPhoto | undefined) ?? null);
      req.onerror = () => resolve(null);
    },
    null,
  );
}

/** The photograph the visitor was last looking at. Restores a reload in place. */
export function loadLatestPhoto(): Promise<StoredPhoto | null> {
  return tx<StoredPhoto | null>(
    'readonly',
    (store, resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = (req.result as StoredPhoto[] | undefined) ?? [];
        if (all.length === 0) return resolve(null);
        all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        resolve(all[0]);
      };
      req.onerror = () => resolve(null);
    },
    null,
  );
}

export function listPhotos(): Promise<StoredPhoto[]> {
  return tx<StoredPhoto[]>(
    'readonly',
    (store, resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = (req.result as StoredPhoto[] | undefined) ?? [];
        all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        resolve(all);
      };
      req.onerror = () => resolve([]);
    },
    [],
  );
}

/** The visitor asked us to forget their photograph. It must actually be gone. */
export async function deletePhoto(hash: string): Promise<void> {
  await tx<void>('readwrite', (store) => {
    store.delete(hash);
  }, undefined);
}

export async function clearPhotos(): Promise<void> {
  await tx<void>('readwrite', (store) => {
    store.clear();
  }, undefined);
}

async function evictOldest(): Promise<void> {
  const all = await listPhotos();
  if (all.length <= MAX_KEPT) return;
  for (const stale of all.slice(MAX_KEPT)) await deletePhoto(stale.hash);
}
