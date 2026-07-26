'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * One tap to send the postcard onward. Every forward is a new visitor, so the
 * cheapest path wins: the native share sheet with the video file attached where
 * the browser allows it, a WhatsApp deep link where it does not, and a copy
 * button that always works.
 */

export interface ShareSheetProps {
  /** The link that travels with the card — the monument, not this page. */
  url: string;
  /** The message body. Usually Mayura's caption, in the visitor's language. */
  text: string;
  /** The recorded clip or the PNG fallback. Omit to share the link alone. */
  file?: File | null;
  title?: string;
  className?: string;
  onShared?: (channel: 'native' | 'native-link' | 'whatsapp' | 'copy') => void;
}

export default function ShareSheet({ url, text, file = null, title = 'Bol', className = '', onShared }: ShareSheetProps) {
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const message = useMemo(() => (text ? `${text}\n${url}` : url), [text, url]);
  const whatsapp = useMemo(() => `https://wa.me/?text=${encodeURIComponent(message)}`, [message]);

  const canShareFiles = useMemo(() => {
    if (typeof navigator === 'undefined' || !navigator.share || !file) return false;
    const canShare = (navigator as Navigator & { canShare?: (d: ShareData) => boolean }).canShare;
    if (typeof canShare !== 'function') return false;
    try {
      return canShare({ files: [file] });
    } catch {
      return false;
    }
  }, [file]);

  // One object URL per file, revoked when the file changes or the sheet unmounts.
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setFileUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const share = useCallback(async () => {
    setNote(null);
    if (typeof navigator === 'undefined' || !navigator.share) {
      window.open(whatsapp, '_blank', 'noopener,noreferrer');
      onShared?.('whatsapp');
      return;
    }
    try {
      if (canShareFiles && file) {
        await navigator.share({ files: [file], text, title });
        onShared?.('native');
      } else {
        await navigator.share({ text, url, title });
        onShared?.('native-link');
        if (file) setNote('This browser shares links but not files. The clip is in your downloads.');
      }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      window.open(whatsapp, '_blank', 'noopener,noreferrer');
      onShared?.('whatsapp');
    }
  }, [canShareFiles, file, onShared, text, title, url, whatsapp]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      onShared?.('copy');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setNote('The browser blocked the clipboard. The link is in the box below — long-press to copy it.');
    }
  }, [message, onShared]);

  return (
    <div className={`flex w-full flex-col gap-2 ${className}`}>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void share()}
          className="bol-glass flex-1 px-4 py-3 text-sm font-medium text-sandstone-50"
        >
          {canShareFiles ? 'Send this postcard' : 'Share'}
        </button>
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onShared?.('whatsapp')}
          className="bol-glass px-4 py-3 text-sm font-medium text-emerald-200"
        >
          WhatsApp
        </a>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={() => void copy()} className="bol-chip">
          {copied ? 'Copied' : 'Copy link'}
        </button>
        {file && fileUrl && (
          <a href={fileUrl} download={file.name} className="bol-chip">
            Save to phone
          </a>
        )}
      </div>

      <p className="select-all break-all rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-sandstone-200/60">
        {url}
      </p>

      {note && <p className="text-xs text-amber-200/80">{note}</p>}
    </div>
  );
}
