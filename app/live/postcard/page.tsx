'use client';

import { useCallback, useMemo, useState } from 'react';

import PostcardCard, { type PostcardExport } from '@/components/postcard/PostcardCard';
import ShareSheet from '@/components/postcard/ShareSheet';

/**
 * A harness for the postcard, not part of the visitor journey.
 *
 * In the real flow the monument offers the postcard after five turns, the visitor
 * says their name aloud, and Saaras has already decided the language — there is no
 * picker anywhere in this product. Here the name is typed and the language comes
 * off the query string (`/live/postcard?lang=ta-IN`) so the card can be exercised
 * indoors, without a microphone, while the rest of the app is being built.
 */

interface ComposeResponse {
  text?: string | null;
  audio?: string | null;
  caption?: string | null;
  captionModel?: string | null;
  shareUrl?: string;
  qrSvg?: string;
  ms?: number;
  monumentName?: string;
  hero?: string;
  langNative?: string;
  voiceNotice?: string | null;
  error?: string;
  kind?: string;
}

const FALLBACK_HERO = '/monuments/qutub-minar/hero.png';

export default function PostcardHarness() {
  const [name, setName] = useState('');
  const [state, setState] = useState<'idle' | 'composing' | 'ready' | 'error'>('idle');
  const [data, setData] = useState<ComposeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<PostcardExport | null>(null);

  const params = useMemo(
    () => (typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)),
    [],
  );
  const lang = params.get('lang') ?? 'hi-IN';
  const monumentId = params.get('m') ?? 'qutub-minar';

  const compose = useCallback(async () => {
    setState('composing');
    setError(null);
    setExported(null);
    try {
      const res = await fetch('/api/postcard/compose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ monument_id: monumentId, name, lang }),
      });
      const json = (await res.json()) as ComposeResponse;
      setData(json);
      if (!res.ok) {
        setError(
          json.kind === 'not_configured'
            ? 'No Sarvam key in this environment, so there is no farewell and no voice. The card below is still real — the photograph, the QR and the link are exactly what a visitor would get.'
            : (json.error ?? `The compose route answered ${res.status}.`),
        );
        setState(json.shareUrl ? 'ready' : 'error');
        return;
      }
      setState('ready');
    } catch (err) {
      setError((err as Error).message);
      setState('error');
    }
  }, [lang, monumentId, name]);

  const shareUrl = data?.shareUrl ?? `${typeof window === 'undefined' ? '' : window.location.origin}/?m=${monumentId}&via=postcard`;
  const caption = data?.caption ?? 'I am still here. Come and talk to me.';

  return (
    <main className="fixed inset-0 overflow-y-auto overscroll-contain bg-night-900 text-sandstone-100">
      <div className="mx-auto w-full max-w-md px-4 pb-16 pt-6">
        <header className="mb-4">
          <h1 className="text-xl font-semibold">Voice postcard — harness</h1>
          <p className="mt-1 text-xs text-sandstone-200/60">
            Language <span className="text-sandstone-100">{lang}</span> comes from the query string here; in the product it
            comes from Saaras. Monument <span className="text-sandstone-100">{monumentId}</span>.
          </p>
        </header>

        <div className="bol-glass mb-4 flex gap-2 p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="the visitor's name"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-sandstone-50 placeholder:text-sandstone-200/35 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void compose()}
            disabled={!name.trim() || state === 'composing'}
            className="bol-chip px-4 py-2 disabled:opacity-50"
          >
            {state === 'composing' ? 'Composing…' : 'Compose'}
          </button>
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
            {error}
          </p>
        )}

        {data?.text && (
          <p className="indic-text bol-glass mb-4 px-4 py-3 text-[15px] text-sandstone-50">{data.text}</p>
        )}
        {data?.voiceNotice && <p className="mb-4 text-xs text-amber-200/75">{data.voiceNotice}</p>}
        {data?.captionModel && (
          <p className="mb-4 text-[11px] text-sandstone-200/50">
            caption model: <span className="text-sandstone-100">{data.captionModel}</span>
            {typeof data.ms === 'number' && ` · ${data.ms} ms`}
          </p>
        )}

        {state === 'ready' && (
          <>
            <PostcardCard
              heroSrc={data?.hero ?? FALLBACK_HERO}
              caption={caption}
              audioUrl={data?.audio ?? null}
              shareUrl={shareUrl}
              monumentName={data?.monumentName ?? 'Qutub Minar'}
              visitorName={name.trim()}
              onExported={setExported}
            />
            <div className="mt-4">
              <ShareSheet url={shareUrl} text={caption} file={exported?.file ?? null} />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
