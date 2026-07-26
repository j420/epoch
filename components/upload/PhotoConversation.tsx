'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import LivingPhoto from '@/components/LivingPhoto';
import { LanguageChip, MicButton, TextFallback, TranscriptRail } from '@/components/voice';
import useVoiceLoop from '@/hooks/useVoiceLoop';
import { Director } from '@/lib/director';
import type { LivingPhotoHandle } from '@/lib/types';
import { ungroundedOpenings, type UserMonument } from '@/lib/userMonument';

import UngroundedBadge from './UngroundedBadge';

/**
 * A visitor's own photograph, alive and talking.
 *
 * Visually this is the Stage: the same `LivingPhoto` engine, the same `Director`
 * mapping voice state onto camera behaviour, the same `useVoiceLoop`, the same
 * mic button and transcript rail. Nothing about the *experience* is a lesser
 * version of the real thing, and that is the point — the 2.5D displacement and
 * the camera rig are the most impressive part of this feature and they run
 * entirely in the browser, with or without an API key.
 *
 * Epistemically it is a different creature, and the UI says so from the first
 * frame. See `UngroundedBadge`, and `lib/userMonument.ts` for why an uploaded
 * photograph structurally cannot narrate history.
 */

const INVITATION_MS = 2600;

export interface PhotoConversationProps {
  monument: UserMonument;
  /** Start over with a different photograph. */
  onNewPhoto: () => void;
  /** Delete this photograph from the device. */
  onForget: () => void;
}

export default function PhotoConversation({ monument, onNewPhoto, onForget }: PhotoConversationProps) {
  const photoRef = useRef<LivingPhotoHandle | null>(null);
  const directorRef = useRef<Director | null>(null);

  const [photoReady, setPhotoReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [invitationIndex, setInvitationIndex] = useState(0);
  const [showRail, setShowRail] = useState(true);
  const [offerDismissed, setOfferDismissed] = useState(false);

  // -------------------------------------------------------------------------
  // The seam with the voice lane
  // -------------------------------------------------------------------------

  /**
   * Installed BEFORE the loop can issue a turn (effects run at mount, the first
   * turn needs a tap), so no answer request can escape to /api/answer and be
   * answered in a real monument's grounded voice. A getter, not a snapshot, so a
   * late-arriving Vision description is picked up on the next turn.
   */
  const configRef = useRef({ monumentId: monument.id, description: monument.description, regions: monument.regions });
  configRef.current = {
    monumentId: monument.id,
    description: monument.description,
    regions: monument.regions,
  };

  /**
   * The photograph answers through /api/photo/answer, never /api/answer. That route
   * has no access to source chunks and no parameter that could carry one, which is
   * what makes fabricated history structurally impossible here. Routing it through
   * the grounded endpoint would have the photo answer in Qutub Minar's cited voice,
   * because an unknown monument id resolves to the registry default.
   */
  const voice = useVoiceLoop({
    monumentId: monument.id,
    autoVad: true,
    answerEndpoint: '/api/photo/answer',
    answerExtras: {
      description: monument.description,
      regions: monument.regions.map((r) => ({ id: r.id, label: r.label['en-IN'] ?? r.id })),
    },
  });

  // -------------------------------------------------------------------------
  // Director wiring — identical to the Stage's
  // -------------------------------------------------------------------------

  useEffect(() => {
    const director = new Director();
    directorRef.current = director;
    return () => director.dispose();
  }, []);

  useEffect(() => {
    if (photoReady) directorRef.current?.attach(photoRef.current, monument);
  }, [photoReady, monument]);

  useEffect(() => {
    directorRef.current?.setVoiceState(voice.state);
  }, [voice.state]);

  useEffect(() => {
    if (voice.directive) directorRef.current?.apply(voice.directive);
  }, [voice.directive]);

  // -------------------------------------------------------------------------
  // Analytics. No image data — see /api/photo/created.
  // -------------------------------------------------------------------------

  const loggedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!voice.ready || loggedRef.current === monument.hash) return;
    loggedRef.current = monument.hash;
    void fetch('/api/photo/created', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hash: monument.hash,
        aspect: monument.aspect,
        depthSource: monument.depthSource,
        regionIds: monument.regions.map((r) => r.id),
        matchedMonumentId: monument.matchedMonumentId,
        confidence: monument.confidence,
        hasDescription: monument.description.length > 0,
        sessionId: voice.sessionId ?? undefined,
      }),
    }).catch(() => undefined);
  }, [voice.ready, voice.sessionId, monument]);

  // -------------------------------------------------------------------------
  // The cycling invitation — the instruction, with no language picker
  // -------------------------------------------------------------------------

  const invitations = useMemo(() => ungroundedOpenings(), []);

  useEffect(() => {
    if (started || invitations.length < 2) return;
    const id = setInterval(() => setInvitationIndex((i) => (i + 1) % invitations.length), INVITATION_MS);
    return () => clearInterval(id);
  }, [started, invitations.length]);

  const handleStart = useCallback(async () => {
    if (!started) setStarted(true);
    try {
      const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } })
        .DeviceOrientationEvent;
      if (typeof DOE?.requestPermission === 'function') await DOE.requestPermission().catch(() => undefined);
    } catch {
      /* parallax is a nicety; never let it block the microphone */
    }
    await voice.start();
  }, [started, voice]);

  const turnCount = voice.turns.length;
  const configured = voice.capabilities.configured;
  const sttDown = voice.ready && configured && !voice.capabilities.stt;
  const ttsDown = voice.ready && !voice.capabilities.tts;
  const current = invitations[invitationIndex];
  const showOffer = Boolean(monument.matchedMonumentId) && !offerDismissed;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-night-950">
      {/* ---- the photograph ---------------------------------------------- */}
      <LivingPhoto
        ref={photoRef}
        monument={monument}
        className="absolute inset-0"
        onReady={() => setPhotoReady(true)}
        // Depth already ran once in this browser. If it produced nothing there is
        // no WebGPU here and a second 45-second attempt would only cost battery —
        // go straight to the flat plane with Ken Burns.
        allowDepthCompute={monument.depthSource !== 'none'}
      />

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-black/35" />

      {/* ---- top rail: what this is, and what we detected ------------------ */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
        <div className="pointer-events-auto flex flex-col items-start gap-2">
          <UngroundedBadge
            matchedMonumentId={monument.matchedMonumentId}
            identifiedAs={monument.identifiedAs}
          />
          <LanguageChip lang={voice.lang} notice={voice.voiceNotice} />
        </div>
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <button type="button" onClick={onNewPhoto} className="bol-chip">
            new photo
          </button>
          {started && (
            <button
              type="button"
              onClick={() => setShowRail((v) => !v)}
              className="bol-chip"
              aria-label={showRail ? 'Hide transcript' : 'Show transcript'}
            >
              {showRail ? 'hide text' : 'show text'}
            </button>
          )}
        </div>
      </div>

      {/* ---- the best possible outcome: we hold the real, cited one -------- */}
      {showOffer && (
        <div className="absolute inset-x-0 top-24 flex justify-center px-4">
          <div className="bol-glass max-w-sm p-4">
            <p className="text-sm leading-relaxed text-sandstone-100">
              This looks like a monument we actually hold research on
              {monument.identifiedAs ? <> — <span className="font-semibold">{monument.identifiedAs}</span></> : null}.
              That one answers from cited sources and can tell you its history. This photograph cannot.
            </p>
            <div className="mt-3 flex gap-2">
              <a
                href="/"
                className="flex-1 rounded-lg bg-sandstone-300 px-3 py-2 text-center text-sm font-semibold text-night-900"
              >
                Talk to the real one
              </a>
              <button
                type="button"
                onClick={() => setOfferDismissed(true)}
                className="rounded-lg border border-white/15 px-3 py-2 text-sm text-sandstone-200/70"
              >
                Stay here
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- the conversation --------------------------------------------- */}
      {started && showRail && turnCount > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-44 px-4">
          <TranscriptRail
            turns={voice.turns}
            limit={4}
            emphasiseLatestAnswer={ttsDown}
            className="pointer-events-auto mx-auto max-w-md"
          />
        </div>
      )}

      {/* ---- the invitation, in every tongue it speaks ---------------------- */}
      {!started && current && configured && (
        <div className="pointer-events-none absolute inset-x-0 bottom-52 px-8 text-center">
          <p
            key={current.lang}
            lang={current.lang}
            className="indic-text mx-auto max-w-sm animate-[fadeIn_600ms_ease-out] text-balance text-lg font-medium text-sandstone-50 drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]"
          >
            {current.text}
          </p>
          <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
            {invitations.map((inv, i) => (
              <span
                key={inv.lang}
                className={`h-1 rounded-full transition-all duration-500 ${
                  i === invitationIndex ? 'w-5 bg-sandstone-200/90' : 'w-1 bg-sandstone-200/30'
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {/* ---- no key: you can look at it, but not talk to it yet ------------- */}
      {voice.ready && !configured && (
        <div className="absolute inset-x-0 bottom-8 flex justify-center px-4">
          <div className="bol-glass max-w-sm p-4 text-center">
            <p className="text-sm leading-relaxed text-sandstone-100">
              Your photograph is alive — you can look at it, tilt it, watch the light move. It cannot talk
              back yet: this deployment has no speech key configured.
            </p>
            <p className="mt-2 text-xs text-sandstone-200/60">
              Everything you are looking at was made on this device. The depth was inferred in your
              browser; nothing was uploaded to produce it.
            </p>
            <button
              type="button"
              onClick={onNewPhoto}
              className="mt-3 w-full rounded-lg border border-white/15 px-3 py-2 text-sm text-sandstone-100"
            >
              Try another photograph
            </button>
          </div>
        </div>
      )}

      {/* ---- the one thing to do -------------------------------------------- */}
      {configured && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 pb-8">
          {sttDown ? (
            <TextFallback
              onSubmit={voice.submitText}
              message={
                voice.error?.message ??
                'I cannot hear you right now — the voice service is unavailable. Write to me instead, in any language.'
              }
              className="mx-auto w-full max-w-md px-4"
            />
          ) : (
            <MicButton
              state={voice.state}
              onStart={handleStart}
              onStop={voice.stop}
              getAnalyser={voice.getAnalyser}
              level={voice.level}
              disabled={!voice.ready}
              size={started ? 76 : 92}
            />
          )}

          {voice.needsTapToPlay && (
            <button type="button" onClick={voice.playPending} className="bol-chip">
              tap to hear the answer
            </button>
          )}

          {voice.error && voice.error.stage !== 'session' && (
            <p role="alert" className="mx-6 max-w-md text-center text-xs text-sandstone-200/70">
              {voice.error.message}
            </p>
          )}
        </div>
      )}

      {/* ---- the promise we made about their photograph ---------------------- */}
      <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center px-4">
        <button
          type="button"
          onClick={onForget}
          className="pointer-events-auto text-[10px] tracking-wide text-sandstone-200/35 underline-offset-2 hover:underline"
        >
          kept only on this device · forget it
        </button>
      </div>
    </main>
  );
}
