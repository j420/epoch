# Bol — बोल

**A monument that listens in 22 Indian languages, answers in yours, and remembers what you tell it.**

Scan a QR at Qutub Minar. A photograph of the tower fills your phone and begins to breathe.
You speak — in Tamil, in Bhojpuri-inflected Hindi, in Malayalam, in whatever tongue you
actually think in. There is no language menu. The monument works out what you speak from
the first thing you say, glides its camera to the balcony you asked about, and answers you
in your own language, in first person, in two sentences.

Then it asks you to leave a memory. The next visitor will hear it.

---

## Why there is no language picker

Every multilingual product in India starts with a dropdown of twenty-two options, and every
one of them loses the visitor who cannot read the list. Bol's language comes from Saaras
auto-detection on the visitor's **first utterance** and drives the entire downstream chain —
retrieval, generation, voice, captions, consent copy, the thank-you after a donation.

The only language UI in the whole product is a small chip that appears *after* you speak:
"தமிழ் detected". A confirmation, never a choice. If you switch language mid-conversation,
the monument follows you.

If you find a `<select>` of languages anywhere in this repo, it is a bug.

## The seven rules

1. No app install. One URL from a QR code, working on a mid-range Android over 4G.
2. No language picker. Anywhere.
3. The monument speaks in **first person**. "I am Qutub Minar", never "Qutub Minar was built".
4. Every factual claim comes from a retrieved source chunk. When retrieval finds nothing,
   the monument says it does not remember. It never invents history.
5. Two sentences maximum in anything spoken.
6. Real photographs made cinematic. No 3D models.
7. Demonstrable indoors, in a conference room, not at a monument.

---

## Architecture

```
                 ┌──────────────────────────────────────────────┐
   voice ───────▶│ /api/listen   Saaras saaras:v3 · codemix      │
                 │               → { transcript, language_code }  │  ← the only
                 └──────────────────────┬───────────────────────┘     language
                                        │                              decision
                        ┌───────────────▼───────────────┐              in the
                        │ route: SIMPLE DEEP MEMORY     │              product
                        │        REPORT VISUAL          │
                        └───────────────┬───────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
      retrieve sources          echo wall memories        conservation report
      (thresholded — can        (Saaras verbatim +        (Vision + 105B
       return nothing)           transcribe, consented)    classification)
              │                         │                         │
              └─────────────────────────┼─────────────────────────┘
                                        ▼
                        sarvam-30b (simple) / sarvam-105b (deep)
                        answer + trailing {"focus","grade","era"}
                                        │
                     ┌──────────────────┴──────────────────┐
                     ▼                                     ▼
            Bulbul bulbul:v3                      the director
            in the detected language              camera · grade · era
                     │                                     │
                     └──────────────┬──────────────────────┘
                                    ▼
                        the living photograph
```

### The living photograph

We do not render 3D. We take a photograph, displace it by a depth map into a 256×256 2.5D
mesh, and move a cinematic camera through that shallow depth. Parallax follows the phone's
gyroscope, heavily smoothed so the world feels like it has weight. Dust motes drift, birds
cross the frame every half minute, heat shimmers in the lower third, and a time-of-day grade
warms or cools the light. It reads as a photograph that breathes.

The depth map is precomputed and shipped beside the hero image. If it is missing, the engine
runs Depth Anything V2 Small in-browser on WebGPU and caches the result in IndexedDB. If
WebGPU is unavailable, it degrades to a flat plane with a Ken Burns move. It never blocks.

### The language gap, handled honestly

Saaras understands 23 languages. Bulbul speaks 11. When a visitor speaks Santali or Kashmiri
or Manipuri, Bol does not pretend otherwise: it answers in text in their language, voices it
in the nearest supported relative, **tells them so in their own language**, and logs the gap
to the analytics table. See `lib/langs.ts`.

---

## Running it

```bash
npm install
cp .env.example .env.local     # add SARVAM_API_KEY
npm run seed                   # 5 approved memories in 5 languages
npm run dev
```

Nothing but `SARVAM_API_KEY` is required. Supabase, Razorpay and the backup key are all
optional; without them the app falls back to a file-backed store in `.data/` and every
feature that needs a missing key says so plainly rather than spinning forever.

### Verify the live API surface

`docs.sarvam.ai` is unreachable from some build environments, and Sarvam has renamed
response fields between versions (`audios` vs `audio`, `content` vs `text`). `lib/sarvam.ts`
reads every known variant. Once you have a key:

```bash
curl -s localhost:3000/api/sarvam/selftest | jq
```

This calls each endpoint for real and prints the **actual** top-level response keys, so you
can confirm which variant is live instead of guessing.

---

## Layout

| Path | What lives there |
| --- | --- |
| `lib/sarvam.ts` | The one typed Sarvam client. Retry, backoff, LRU caches, TTS chunking, the `reasoning_effort` trap handled once. Server-only. |
| `lib/langs.ts` | 23 languages, Bulbul's 11, fallback chains, honest gap notices. |
| `lib/retrieval.ts` | Character-n-gram TF-IDF — queries arrive in a dozen scripts, the corpus is English. Thresholded so it can return nothing. |
| `lib/director.ts` | Binds the monument's visual directives and cue tracks to the camera. |
| `lib/db.ts` | Supabase or a file store. Every dashboard number comes from a real row here. |
| `content/qutub-minar.json` | 10 cited source chunks, 7 named regions, names in 13 languages. |
| `docs/BUILD-CONTRACT.md` | Interfaces, file ownership, conventions. |

## Debug routes

| Route | For |
| --- | --- |
| `/debug/photo` | Depth scale, grade, vignette, focus radius, region jump |
| `/debug/voice` | Per-stage latency against the budget |
| `/debug/cue` | Scrub narration audio, place cues by clicking the image |
| `/live` | The public dashboard. Real rows only, never a mocked number. |
| `/admin` | One-click memory moderation |

## Latency budget

```
Saaras 150 · routing 200 · retrieval 50 · generation 600 · Bulbul first byte 200
target: under 1.2s speech to speech
```

Measured per stage and written to `turns.latency_ms` on every turn.

## Placeholder assets

`public/monuments/qutub-minar/` currently holds a **procedurally generated** tower and a
depth map that is genuinely correct for it — every image host was blocked from the build
environment. The parallax, the region moves and the focus spotlight are all really working
against it. Swap in a real photograph (≤2048px long edge, WebP, <400KB) and a Depth Anything
V2 map (1024px greyscale, <200KB) and update the two paths in `content/qutub-minar.json`.
Nothing else changes.
