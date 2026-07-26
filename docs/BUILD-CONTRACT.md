# Bol — build contract

Read this before writing a line. Several agents are building this repo in parallel.
The foundation below already exists and is **frozen** — build on it, do not rewrite it.

## The product in one sentence

Bol is a scan-and-speak web page where a visitor talks to a monument in any of 22 Indian
languages with **no language picker**, sees a photoreal image of that monument move in
response, hears the answer in their own language, and can leave a spoken memory that the
next visitor will hear.

## Seven rules that override any local design decision

1. **No app install.** One URL from a QR code. Must work on a mid-range Android over 4G.
2. **No language picker. Anywhere.** Language comes from Saaras auto-detection on the first
   utterance and drives everything downstream. If you are adding a `<select>` of languages,
   you have taken a wrong turn. A *confirmation chip* after detection ("Tamil detected") is
   correct; a *choice* is not.
3. **First person, always.** "I am Qutub Minar", never "Qutub Minar was built".
4. **Every factual claim comes from a retrieved source chunk.** If retrieval returns nothing,
   the monument says it does not remember. Never invent history.
5. **Two sentences maximum** in anything spoken.
6. **Real photographs made cinematic.** No 3D models, ever.
7. **Demonstrable indoors**, in a conference room, not at a monument.

## Frozen foundation — use these, do not reimplement

| Module | What it gives you |
| --- | --- |
| `lib/sarvam.ts` | `listen` `speak` `chat` `translate` `readDocument` `sarvamFetch`. Retry + backoff, LRU caches, typed errors, TTS chunking, WAV concat, the `reasoning_effort` trap handled once. **Server-only.** |
| `lib/langs.ts` | The 23-language table, `normalizeLang`, `resolveVoice` (Bulbul's 11 vs Saaras's 23), `voiceGapNotice`, `detectedChip`. |
| `lib/errors.ts` | `SarvamRateLimit` `SarvamAuth` `SarvamBadResponse` `SarvamNotConfigured`, `toErrorPayload(err)` → `{error, kind, status}` for route responses. |
| `lib/db.ts` | `createSession` `setSessionLang` `logTurn` `logEvent` `insertMemory` `listMemories` `approveMemory` `insertReport` `listReports` `liveStats`. Supabase when configured, file-backed `.data/store.json` otherwise. |
| `lib/retrieval.ts` | `retrieveSources` (returns `empty: true` when nothing clears threshold — honour it), `TextIndex`, `formatSources`, `setEmbedder`. |
| `lib/monuments.ts` | `getMonument` `displayName` `regionLabel` `findRegion`. |
| `lib/types.ts` | `Monument` `Region` `SourceChunk` `VisualDirective` `Cue` `Intent` `Memory` `AnswerResult`… |
| `lib/wav.ts` | `concatAudio` `b64ToBytes` `bytesToB64`. |
| `content/qutub-minar.json` | 10 cited source chunks, 7 named regions, display names and intro lines in 6+ languages. |

## Hard conventions

- **Import alias `@/`** maps to the repo root. `import { speak } from '@/lib/sarvam'`.
- **`lib/sarvam.ts` and `lib/db.ts` are `server-only`.** Importing them into a client
  component is a build error. Client code talks to `/api/*` routes.
- **Never read `process.env.SARVAM_API_KEY` outside `lib/sarvam.ts`.**
- **Every API route** exports `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`, and
  wraps its body in try/catch ending in `toErrorPayload(err)`.
- **Every failure has a visible, honest fallback.** A judge should be happy to see any
  error path. No silent failures, no fake data.
- **Tailwind only** for styling; use `.bol-glass` / `.bol-chip` from `globals.css`.
- **No `npm install`.** Dependencies are already installed. If you genuinely need a new one,
  write it in your final report instead of installing it — a concurrent install will
  corrupt another agent's `node_modules`.
- **TypeScript strict.** Run `npx tsc --noEmit` before you finish. It must pass for the
  files you own.

## The visual directive — the contract between voice and visuals

The answering model appends one line of JSON after its reply:

```json
{"focus":"dome","grade":"dusk","era":"1900"}
```

`focus` is a region id from the monument JSON (or null), `grade` is
`dawn|noon|dusk|night|sepia` (or null), `era` is a year present in `monument.eras` (or null).
Parse it off the end, strip it from the spoken text, and pass the `VisualDirective` to the
visual engine. **If it is malformed, ignore it silently and speak the text anyway.**

## Visual engine public API (owned by the visual agent, consumed by everyone)

```ts
export interface LivingPhotoHandle {
  to(region: string, opts?: { duration?: number; ease?: string }): void;
  driftIn(opts?: { amount?: number; duration?: number }): void;
  orbitMicro(opts?: { amplitude?: number }): void;
  grade(g: Grade, ms?: number): void;
  era(year: string | null, ms?: number): void;
  focus(region: string | null, radius?: number): void;
  listening(on: boolean): void;   // pull back + desaturate while the visitor speaks
  reset(): void;
}
```

## File ownership — do not write outside your lane

| Lane | Owns |
| --- | --- |
| foundation (done) | `lib/*` (except lanes below), `content/*`, `app/layout.tsx`, `app/globals.css`, `app/api/sarvam/**`, `app/api/health`, config files |
| visual | `components/LivingPhoto/**`, `lib/depth.ts`, `lib/grades.ts`, `app/debug/photo/**` |
| voice | `app/api/listen`, `app/api/answer`, `app/api/speak`, `app/api/session`, `lib/prompts.ts`, `lib/directive.ts`, `components/voice/**`, `hooks/**`, `app/debug/voice/**` |
| echo | `app/api/memories/**`, `components/echo/**`, `app/admin/**`, `content/seed-memories.json`, `scripts/seed.ts` |
| vision | `app/api/plaque`, `app/api/report`, `components/vision/**` |
| guide | `app/guide/**`, `app/join/**`, `app/api/guide/**`, `lib/dub.ts` |
| growth | `app/api/postcard`, `app/api/razorpay/**`, `app/live/**`, `components/postcard/**`, `lib/qr.ts` |
| integration (me) | `app/page.tsx`, `components/Stage.tsx`, `lib/director.ts`, service worker, smoke tests |

If you need something from another lane that does not exist yet, **define the interface,
code against it, and note the dependency in your report**. Do not create the other lane's files.

## Latency budget (measure it, log it to `turns.latency_ms`)

```
Saaras 150ms | routing 200ms | retrieval 50ms | generation 600ms | Bulbul first byte 200ms
Target: under 1.2s speech-to-speech.
```

## Sarvam field-name caution

`docs.sarvam.ai` is blocked from this environment, and Sarvam has renamed response fields
between versions (`audios` vs `audio`, `content` vs `text`, `transcript` vs `text`).
`lib/sarvam.ts` already reads every known variant via `readTranscript` / `readAudioB64` /
`readChatContent` / `readTranslation`. **Use those readers.** Once a live key exists,
`GET /api/sarvam/selftest` prints the real response shapes so we can confirm.

## Working without an API key

There is no Sarvam key in this environment yet. Every route must therefore:

- return `503 {kind:'not_configured'}` via `toErrorPayload` when `isConfigured()` is false, and
- have its UI degrade to the honest fallback for that feature (text input, large text answer,
  Ken Burns-only photo, etc).

Build and typecheck are the acceptance bar right now, not live API responses.
