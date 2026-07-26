/**
 * WAV surgery.
 *
 * Bulbul returns one base64 clip per request. When we chunk a long narration we get
 * N clips back and must hand the browser ONE audio blob. Naively concatenating WAV
 * buffers embeds a 44-byte RIFF header in the middle of the stream: most decoders
 * play only the first chunk and silently drop the rest. That failure looks exactly
 * like "the monument stopped talking", so we parse and rebuild properly.
 */

export interface WavParts {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Uint8Array;
}

const ascii = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export function isWav(buf: Uint8Array): boolean {
  return buf.length > 12 && ascii(buf, 0) === 'RIFF' && ascii(buf, 8) === 'WAVE';
}

/** Walks the chunk list rather than assuming a 44-byte header (LIST/fact chunks are common). */
export function parseWav(buf: Uint8Array): WavParts | null {
  if (!isWav(buf)) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12;
  let fmt: Omit<WavParts, 'data'> | null = null;
  let data: Uint8Array | null = null;

  while (offset + 8 <= buf.length) {
    const id = ascii(buf, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // Some encoders write 0xFFFFFFFF or an over-long size for streamed output.
      const end = Math.min(buf.length, body + size);
      data = buf.subarray(body, end);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
    if (size === 0) break;
  }
  if (!fmt || !data) return null;
  return { ...fmt, data };
}

export function buildWav(parts: Omit<WavParts, 'data'>, pcm: Uint8Array): Uint8Array {
  const blockAlign = (parts.channels * parts.bitsPerSample) / 8;
  const byteRate = parts.sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const write = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, parts.format, true);
  view.setUint16(22, parts.channels, true);
  view.setUint32(24, parts.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, parts.bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Concatenate N audio buffers into one. WAV gets a rebuilt header; anything else
 * (mp3/opus frame streams) concatenates byte-wise, which those formats tolerate.
 */
export function concatAudio(buffers: Uint8Array[]): { bytes: Uint8Array; mime: string } {
  const usable = buffers.filter((b) => b && b.length > 0);
  if (usable.length === 0) return { bytes: new Uint8Array(0), mime: 'audio/wav' };
  if (usable.length === 1) {
    return { bytes: usable[0], mime: isWav(usable[0]) ? 'audio/wav' : 'audio/mpeg' };
  }

  const parsed = usable.map(parseWav);
  if (parsed.every((p): p is WavParts => p !== null)) {
    const head = parsed[0];
    const mismatch = parsed.find(
      (p) => p.sampleRate !== head.sampleRate || p.channels !== head.channels || p.bitsPerSample !== head.bitsPerSample,
    );
    if (!mismatch) {
      const total = parsed.reduce((n, p) => n + p.data.length, 0);
      const pcm = new Uint8Array(total);
      let o = 0;
      for (const p of parsed) {
        pcm.set(p.data, o);
        o += p.data.length;
      }
      return { bytes: buildWav(head, pcm), mime: 'audio/wav' };
    }
    console.warn('[wav] chunk format mismatch across TTS calls; falling back to byte concat');
  }

  const total = usable.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of usable) {
    out.set(b, o);
    o += b.length;
  }
  return { bytes: out, mime: isWav(usable[0]) ? 'audio/wav' : 'audio/mpeg' };
}

export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

export function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
