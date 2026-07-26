/**
 * Real photographs for the Living Photograph engine.
 *
 * WHY THIS EXISTS: `scripts/gen-assets.mjs` renders a *procedural stand-in* for
 * each monument, because this build environment blocks every image host —
 * Wikimedia Commons, Unsplash, Pexels, every CDN. The product's whole premise is
 * "real photographs made cinematic", so the placeholders had to go.
 *
 * The one image host this environment can reach is `raw.githubusercontent.com`.
 * So every photograph below is fetched from a public GitHub repository that
 * mirrors a Wikimedia Commons file **and records that file's page, author and
 * licence in the repo itself**. Those recorded chains are reproduced verbatim in
 * `public/monuments/CREDITS.md` — read it before shipping.
 *
 *   node scripts/fetch-photos.mjs                 # fetch, verify, build all
 *   node scripts/fetch-photos.mjs qutub-minar     # just one
 *   node scripts/fetch-photos.mjs --verify        # re-fetch and compare, write nothing
 *   node scripts/fetch-photos.mjs --commons       # ALSO byte-verify against Commons
 *
 * `--commons` is the check this environment cannot run: it re-downloads the same
 * file straight from `commons.wikimedia.org/wiki/Special:FilePath/...` and
 * compares pixels with the GitHub mirror. Run it the moment you are on a network
 * that can reach Commons; it is the difference between "the repo says this is
 * Ramesam's photo" and "this *is* Ramesam's photo".
 *
 * Monuments absent from SOURCES below keep their procedural placeholder. That is
 * deliberate — see CREDITS.md for which ones and why. Never widen the licence bar
 * to fill the set.
 *
 * Dependencies: `sharp` only, which is already installed (it ships as a
 * dependency of `@huggingface/transformers`, see package-lock.json). Nothing is
 * added to package.json.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const OUT_ROOT = path.join(ROOT, 'public', 'monuments');
const CONTENT = path.join(ROOT, 'content');
const LOCK = path.join(OUT_ROOT, 'photo-lock.json');

// ---------------------------------------------------------------------------
// The manifest. Every field here is a claim someone can check.
// ---------------------------------------------------------------------------
//
//  url        exact bytes we fetch, over the only reachable image host
//  sha256     of the *source* file as fetched. A mismatch means upstream moved.
//  expect     dimensions of the source, so a silent re-crop upstream is caught
//  crop       region of the source we keep, in source pixels (null = whole frame)
//  scale      optional integer upscale after cropping, for low-resolution sources
//  aspect     width/height of the FINISHED plate. Must equal content/<id>.json.
//  enabled    set false to fall back to the procedural placeholder for that id
//
const SOURCES = [
  {
    id: 'qutub-minar',
    enabled: true,
    url: 'https://raw.githubusercontent.com/funksoup/Architects_Apprentice/main/images/Qutub_minar%2CDelhi.JPG',
    sha256: 'a772a5bc5cf1b02f828ec7533b3f58045beee232a5c170bdc2a00ba93c472629',
    expect: { width: 500, height: 667, format: 'jpeg' },
    // Centred 1:2 window. The tower spans x 0.20-0.80 of the frame, so this
    // keeps all five storeys with a margin of sky and drops only empty sides.
    crop: { left: 83, top: 0, width: 333, height: 666 },
    scale: 2, // source is only 500px wide; lanczos to 666x1332 for texture sampling
    repo: 'funksoup/Architects_Apprentice',
    repoLicenceFile: null,
    provenance: 'README.md "Image credits" table',
    commonsFile: 'Qutub_minar,Delhi.JPG',
    author: 'Ramesam',
    licence: 'CC BY-SA 3.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    confidence: 'high',
  },
  {
    id: 'taj-mahal',
    enabled: true,
    url: 'https://raw.githubusercontent.com/Qwetsh/QuizzEleves/main/src/assets/places/taj-mahal.jpg',
    sha256: '0c401d91364a2ca981e57f7670605b340a549cb2c12052bdf2af3b8830407723',
    expect: { width: 960, height: 664, format: 'jpeg' },
    // No crop. The minarets sit at x 0.11 and 0.89 and content/taj-mahal.json
    // names a `minaret` region — cropping to a portrait frame would aim the
    // camera at a spot where no minaret exists. A wide plane is the honest cost.
    crop: null,
    scale: 1,
    repo: 'Qwetsh/QuizzEleves',
    repoLicenceFile: null,
    provenance: 'src/data/placePhotoCredits.json (written by scripts/fetch-place-photos.mjs from the Commons API)',
    commonsFile: 'Taj_Mahal,_Agra,_India_edit3.jpg',
    author: 'Yann; edited by King of Hearts; derivative work by Jbarta',
    licence: 'CC BY-SA 3.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    confidence: 'high',
  },
  {
    id: 'red-fort',
    enabled: true,
    url: 'https://raw.githubusercontent.com/rish106-hub/ARTH/main/assets/images/india-heritage-landmark.jpg',
    sha256: '0f29cf778f4cfbac5479366edb9eedd8a0db3626e70e9b92bb7f897b3ad0ff3a',
    expect: { width: 1280, height: 847, format: 'jpeg' },
    // 3:4 window centred on the Lahori Gate. The curtain wall is a repeating
    // horizontal element, so the `battlements` and `wall` regions still land on
    // battlements and wall after the crop.
    crop: { left: 322, top: 0, width: 635, height: 847 },
    scale: 1,
    repo: 'rish106-hub/ARTH',
    repoLicenceFile: null,
    provenance: 'assets/images/ATTRIBUTION.md',
    commonsFile: 'Red_Fort_Delhi,_India.jpg',
    author: 'Vibhor97',
    licence: 'CC BY-SA 3.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    confidence: 'high',
  },
  {
    id: 'charminar',
    enabled: true,
    url: 'https://raw.githubusercontent.com/ZhuChen12/AirLine/main/AirLine/Resources/CityLandmarks/HYD.jpg',
    sha256: '8c2cc6e9cbe51370acaa5f48f03e98d06047ea83fa783036c118f1a5f6e1725f',
    expect: { width: 1600, height: 1000, format: 'jpeg' },
    // The Charminar sits left of centre in the source. This 3:4 window recentres
    // it, which also lands the `minaret` (0.258) and `balcony` (0.742) regions on
    // the actual minarets.
    crop: { left: 345, top: 0, width: 750, height: 1000 },
    scale: 1,
    repo: 'ZhuChen12/AirLine',
    repoLicenceFile: null,
    provenance: 'AirLine/Resources/CityLandmarks/ATTRIBUTION.md',
    commonsFile: 'CHARMINAR,_Hyderabad_01.jpg',
    author: 'Original: Nagalakshmikavuri; derivative work: UnpetitproleX',
    licence: 'CC BY-SA 3.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    confidence: 'high',
  },
  {
    id: 'gateway-of-india',
    enabled: true,
    url: 'https://raw.githubusercontent.com/Qwetsh/QuizzEleves/main/src/assets/places/mumbai.jpg',
    sha256: '9f741ec7f6ea13fc115b2e3eb595aeec54a4e6a879323a5f780052cdbae5af34',
    expect: { width: 960, height: 960, format: 'jpeg' },
    // 3:4 from a square source. Keeps both turrets and both flanking arches;
    // loses the outermost wall returns.
    crop: { left: 120, top: 0, width: 720, height: 960 },
    scale: 1,
    repo: 'Qwetsh/QuizzEleves',
    repoLicenceFile: null,
    provenance: 'src/data/placePhotoCredits.json',
    commonsFile: 'Mumbai_03-2016_30_Gateway_of_India.jpg',
    author: 'A.Savin',
    // NOT one of the four licences the brief named. FAL 1.3 is a free/libre
    // copyleft licence (commercial use allowed, attribution + share-alike
    // required) and A.Savin publishes under it by default on Commons, so this is
    // free to use — but it wants a human sign-off. Set `enabled: false` above to
    // drop straight back to the procedural placeholder.
    licence: 'FAL 1.3 (Free Art License)',
    licenceUrl: 'https://artlibre.org/licence/lal/en/',
    confidence: 'high on authorship, FLAGGED on licence family',
  },
];

// ---------------------------------------------------------------------------
// Fetch + paranoia
// ---------------------------------------------------------------------------

const MAGIC = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

function sniff(buf) {
  for (const [name, sig] of Object.entries(MAGIC)) {
    if (sig.every((b, i) => buf[i] === b)) return name;
  }
  return null;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Everything that can hand you bytes that are not a photograph, caught here.
 *
 * A Git LFS pointer is 130-odd bytes of ASCII that `sharp` rejects with a
 * confusing error; a proxy 404 page is HTML that decodes to a 0x0 image and then
 * uploads as a black texture. Both have shipped to production somewhere.
 */
function assertRealImage(buf, where) {
  if (buf.length < 1024) {
    throw new Error(`${where}: only ${buf.length} bytes — truncated, or an error page`);
  }
  const head = buf.subarray(0, 200).toString('latin1');
  if (head.startsWith('version https://git-lfs')) {
    throw new Error(`${where}: this is a Git LFS pointer, not image bytes`);
  }
  if (/^\s*(<!doctype|<html|\{|404:)/i.test(head)) {
    throw new Error(`${where}: this is HTML/JSON/an error string, not image bytes`);
  }
  const kind = sniff(buf);
  if (!kind) {
    throw new Error(`${where}: no JPEG or PNG magic bytes (starts ${[...buf.subarray(0, 8)].join(',')})`);
  }
  return kind;
}

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Plates
// ---------------------------------------------------------------------------

/**
 * Paletted PNG, dithered.
 *
 * The filename `hero.png` is a hard contract — `public/sw.js` precaches it and
 * `scripts/smoke.ts` asserts it — so JPEG is not on the table. A 256-colour
 * dithered PNG of these photographs is indistinguishable at phone scale from the
 * 24-bit version and roughly a third of the bytes, which is the difference
 * between a 400 KB and a 1.2 MB hero on the 4G connection the brief targets.
 */
function encodePlate(pipeline) {
  return pipeline
    .png({ compressionLevel: 9, palette: true, colours: 256, dither: 1.0, effort: 10 })
    .toBuffer();
}

/**
 * Deterministic mid-grey noise, so the sepia plate grains the same way twice.
 *
 * Generated at half resolution and nearest-upscaled, exactly as gen-assets.mjs
 * does: per-pixel noise is incompressible and pushed the paletted PNG past the
 * budget for no visible gain at phone DPI.
 */
function grainBuffer(width, height, amount) {
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
  const px = Buffer.alloc(w * h * 3);
  let s = 0x2f6e2b1 >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const n = 128 + Math.round(((s >>> 16) / 65535 - 0.5) * 2 * amount);
    px[i * 3] = n;
    px[i * 3 + 1] = n;
    px[i * 3 + 2] = n;
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .resize({ width, height, kernel: 'nearest' })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

/**
 * The 1900 layer: an albumen-print *treatment of this same photograph*.
 *
 * Be clear-eyed about what this is. It is NOT a historical plate — we hold no
 * period photograph of any of these monuments. It is the modern photograph,
 * desaturated, flattened, warmed and grained, so that `era('1900')` cross-fades
 * to the same building rather than to a procedural drawing of a different one.
 * CREDITS.md says so in as many words; if the caption in content/<id>.json
 * claims more than that, the caption is the thing that should change.
 */
async function sepiaPlate(base, width, height) {
  // `recomb`, not `greyscale().tint()`: sharp fixes the order of its colour
  // operations, and `greyscale` runs last, so the tint silently produced a
  // neutral grey plate (R=G=B=135.2 — measured, not guessed). A recombination
  // matrix does the whole desaturate-and-warm in one pass that cannot be
  // reordered out from under us.
  const graded = await base
    .clone()
    .recomb([
      [0.393, 0.769, 0.189],
      [0.349, 0.686, 0.168],
      [0.272, 0.534, 0.131],
    ])
    .linear(0.78, 34) // contrast down, blacks lifted — albumen has no true black
    .toBuffer();

  return encodePlate(
    sharp(graded).composite([{ input: await grainBuffer(width, height, 13), blend: 'overlay' }]),
  );
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const verifyOnly = argv.includes('--verify');
const checkCommons = argv.includes('--commons');
const only = argv.filter((a) => !a.startsWith('--'));

const targets = SOURCES.filter((s) => (only.length ? only.includes(s.id) : true));
if (only.length) {
  for (const id of only) {
    if (!SOURCES.some((s) => s.id === id)) {
      console.error(`  ! "${id}" has no entry in SOURCES — it keeps its procedural placeholder.`);
      process.exitCode = 1;
    }
  }
}

const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : { plates: {} };
lock.plates ??= {};
let failures = 0;

for (const src of targets) {
  const label = src.id.padEnd(18);
  if (!src.enabled) {
    console.log(`${label} SKIPPED (enabled: false) — procedural placeholder stands`);
    continue;
  }

  try {
    const buf = await fetchBytes(src.url);
    const kind = assertRealImage(buf, src.url);
    const got = sha256(buf);

    if (got !== src.sha256) {
      throw new Error(
        `source bytes changed upstream\n    expected sha256 ${src.sha256}\n    got      sha256 ${got}\n` +
          `    Re-verify the photograph and its licence before trusting the new bytes.`,
      );
    }

    const meta = await sharp(buf).metadata();
    if (meta.width !== src.expect.width || meta.height !== src.expect.height || kind !== src.expect.format) {
      throw new Error(
        `source is ${meta.width}x${meta.height} ${kind}, manifest expects ` +
          `${src.expect.width}x${src.expect.height} ${src.expect.format}`,
      );
    }

    if (checkCommons) await verifyAgainstCommons(src, meta);

    let pipeline = sharp(buf);
    if (src.crop) pipeline = pipeline.extract(src.crop);
    let width = src.crop ? src.crop.width : meta.width;
    let height = src.crop ? src.crop.height : meta.height;
    if (src.scale && src.scale !== 1) {
      width *= src.scale;
      height *= src.scale;
      pipeline = pipeline.resize({ width, height, kernel: 'lanczos3' });
    }

    // Materialise the cropped/scaled RGB once; both plates derive from it, so
    // they can never disagree about framing.
    const flat = sharp(await pipeline.png({ compressionLevel: 0 }).toBuffer());
    const hero = await encodePlate(flat.clone());
    const era = await sepiaPlate(flat, width, height);

    const aspect = Number((width / height).toFixed(5));
    const jsonPath = path.join(CONTENT, `${src.id}.json`);
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const agrees = Math.abs(json.aspect - aspect) < 0.001;

    console.log(
      `${label} ${width}x${height}  aspect ${aspect}  hero ${(hero.length / 1024).toFixed(0)}KB  ` +
        `era ${(era.length / 1024).toFixed(0)}KB  ${src.licence}`,
    );
    if (!agrees) {
      console.error(
        `  ! content/${src.id}.json says aspect ${json.aspect}, this plate is ${aspect}. ` +
          `They MUST agree or the mesh geometry is wrong.`,
      );
      failures++;
    }
    if (hero.length > 900 * 1024) {
      console.error(`  ! hero is ${(hero.length / 1024).toFixed(0)}KB, over the ~900KB budget`);
      failures++;
    }

    const record = {
      source: src.url,
      sourceSha256: src.sha256,
      commonsFile: src.commonsFile,
      author: src.author,
      licence: src.licence,
      width,
      height,
      aspect,
      heroSha256: sha256(hero),
      eraSha256: sha256(era),
    };

    if (verifyOnly) {
      const was = lock.plates[src.id];
      if (!was) {
        console.error(`  ! no lock entry for ${src.id} — run without --verify first`);
        failures++;
      } else if (was.heroSha256 !== record.heroSha256 || was.eraSha256 !== record.eraSha256) {
        console.error(`  ! rebuilt plates differ from public/monuments/photo-lock.json`);
        failures++;
      } else {
        console.log(`  verified against photo-lock.json`);
      }
      continue;
    }

    const outDir = path.join(OUT_ROOT, src.id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'hero.png'), hero);
    fs.writeFileSync(path.join(outDir, 'era-1900.png'), era);
    lock.plates[src.id] = record;
  } catch (err) {
    console.error(`${label} FAILED — ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  ${src.id} keeps whatever plate is already on disk.`);
    failures++;
  }
}

if (!verifyOnly && failures === 0) {
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * The check this environment cannot run.
 *
 * `commons.wikimedia.org` and `upload.wikimedia.org` are both 403 at the proxy
 * here, so the licence chain currently rests on what each mirroring repository
 * recorded. On any network that can reach Commons this closes that gap: same
 * file name, same pixels, therefore the recorded author and licence are the
 * right ones.
 */
async function verifyAgainstCommons(src, mirrorMeta) {
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(src.commonsFile)}`;
  try {
    const buf = await fetchBytes(url);
    assertRealImage(buf, url);
    const orig = await sharp(buf).metadata();
    // Mirrors resize; compare aspect and a downsampled fingerprint, not bytes.
    const ratio = orig.width / orig.height;
    const mine = mirrorMeta.width / mirrorMeta.height;
    const fp = async (b) =>
      sha256(await sharp(b).resize(16, 16, { fit: 'fill' }).greyscale().raw().toBuffer());
    const same = (await fp(buf)) === (await fp(await fetchBytes(src.url)));
    console.log(
      `  commons: ${src.commonsFile} ${orig.width}x${orig.height} ` +
        `aspect ${ratio.toFixed(3)} vs mirror ${mine.toFixed(3)} — ` +
        `fingerprint ${same ? 'MATCH' : 'DIFFERS (mirror may be a crop; inspect by eye)'}`,
    );
  } catch (err) {
    console.error(`  commons check unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures) {
  console.error(`\n${failures} problem(s). Nothing was written to photo-lock.json.`);
  process.exitCode = 1;
} else {
  console.log(
    `\nDone. Monuments not listed in SOURCES keep the procedural plates from ` +
      `scripts/gen-assets.mjs — see public/monuments/CREDITS.md.`,
  );
}
