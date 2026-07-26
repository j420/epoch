import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { logEvent, supabase } from '@/lib/db';

/**
 * Blob storage for the original voice.
 *
 * Supabase Storage when SUPABASE_URL is set, otherwise a file under .data/audio/
 * served back by GET /api/memories/audio/[file]. If neither is writable — a
 * read-only serverless filesystem with no bucket configured — we do NOT crash and
 * we do NOT pretend: audio_url becomes null, an event is logged, and the memory
 * still lives as text. The echo wall keeps working, just without the voice.
 */

export const AUDIO_DIR = path.join(process.env.BOL_DATA_DIR ?? path.join(process.cwd(), '.data'), 'audio');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'bol';

export type StorageBackend = 'supabase' | 'file' | 'none';

export interface StoredAudio {
  /** Public URL, or null when nothing could be written. Never throws. */
  url: string | null;
  backend: StorageBackend;
  /** Present when we degraded, so the route can log it honestly. */
  reason?: string;
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

export const MIME_BY_EXT: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export function extFor(mime: string): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] ?? 'webm';
}

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Only ever a bare filename: uuid + extension. Nothing user-supplied reaches the path. */
export function newAudioName(mime: string): string {
  return `${randomUUID()}.${extFor(mime)}`;
}

const SAFE_NAME = /^[a-f0-9-]{36}\.(webm|ogg|m4a|aac|mp3|wav)$/i;

export function isSafeAudioName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

export async function putAudio(bytes: Uint8Array, mime: string): Promise<StoredAudio> {
  const name = newAudioName(mime);
  const contentType = MIME_BY_EXT[extFor(mime)] ?? 'audio/webm';

  if (supabaseConfigured()) {
    try {
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      const { error } = await supabase()
        .storage.from(BUCKET)
        .upload(`memories/${name}`, body, { contentType, upsert: false });
      if (error) throw new Error(error.message);
      const { data } = supabase().storage.from(BUCKET).getPublicUrl(`memories/${name}`);
      if (data?.publicUrl) return { url: data.publicUrl, backend: 'supabase' };
      throw new Error('Supabase Storage returned no public URL');
    } catch (err) {
      const reason = `Supabase Storage upload failed: ${(err as Error).message}`;
      console.warn('[echo] ' + reason + ' — falling back to the local file store.');
      // fall through to the file store rather than losing the voice
      const local = await putAudioFile(bytes, name);
      return local.url ? { ...local, reason } : { url: null, backend: 'none', reason };
    }
  }

  return putAudioFile(bytes, name);
}

async function putAudioFile(bytes: Uint8Array, name: string): Promise<StoredAudio> {
  try {
    await fs.mkdir(AUDIO_DIR, { recursive: true });
    const copy = Buffer.from(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await fs.writeFile(path.join(AUDIO_DIR, name), copy);
    return { url: `/api/memories/audio/${name}`, backend: 'file' };
  } catch (err) {
    const reason = `Local audio store is not writable: ${(err as Error).message}`;
    console.warn('[echo] ' + reason);
    await logEvent('memory_audio_storage_failed', { reason });
    return { url: null, backend: 'none', reason };
  }
}

export async function readAudioFile(name: string): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!isSafeAudioName(name)) return null;
  try {
    const bytes = await fs.readFile(path.join(AUDIO_DIR, name));
    const ext = name.split('.').pop()!.toLowerCase();
    return { bytes, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}
