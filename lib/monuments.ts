import qutub from '@/content/qutub-minar.json';
import tajMahal from '@/content/taj-mahal.json';
import redFort from '@/content/red-fort.json';
import gatewayOfIndia from '@/content/gateway-of-india.json';
import hawaMahal from '@/content/hawa-mahal.json';
import charminar from '@/content/charminar.json';
import konark from '@/content/konark-sun-temple.json';
import mysorePalace from '@/content/mysore-palace.json';
import goldenTemple from '@/content/golden-temple.json';
import sanchiStupa from '@/content/sanchi-stupa.json';
import type { Monument, Region } from './types';
import { info, normalizeLang, type LangCode } from './langs';

/**
 * Monument content registry — India's ten best-known monuments.
 *
 * Statically imported so it works in edge runtimes, in the service worker
 * precache manifest, and offline. The JSON files are the single source of truth
 * for names, regions, source chunks and asset paths; `scripts/gen-assets.mjs`
 * renders the hero, depth and era plates keyed by the same ids.
 *
 * The cast to `Monument` is needed because TypeScript infers the JSON's
 * `displayName` / `label` maps as sealed object literals rather than the
 * `Record<string, string>` the type asks for.
 */
const REGISTRY: Record<string, Monument> = {
  'qutub-minar': qutub as Monument,
  'taj-mahal': tajMahal as Monument,
  'red-fort': redFort as Monument,
  'gateway-of-india': gatewayOfIndia as Monument,
  'hawa-mahal': hawaMahal as Monument,
  charminar: charminar as Monument,
  'konark-sun-temple': konark as Monument,
  'mysore-palace': mysorePalace as Monument,
  'golden-temple': goldenTemple as Monument,
  'sanchi-stupa': sanchiStupa as Monument,
};

export const DEFAULT_MONUMENT_ID = 'qutub-minar';

/**
 * Resolve a monument, falling back to the default.
 *
 * The fallback is deliberate — a bad id must never blank the screen — but it is a
 * genuine hazard now that there are ten monuments, because the failure is silent:
 * a typo'd id answers confidently as Qutub Minar, citing Qutub Minar's sources,
 * about a building the visitor is not standing in front of. The uploaded-photo
 * feature hit exactly this and had to work around it.
 *
 * So it now warns, and callers that can do something better — a route that should
 * 404, a feature that must not silently substitute — should ask `hasMonument`
 * first rather than relying on this.
 */
export function getMonument(id: string = DEFAULT_MONUMENT_ID): Monument {
  const found = REGISTRY[id];
  if (found) return found;
  console.warn(`[monuments] unknown id "${id}" — falling back to ${DEFAULT_MONUMENT_ID}. ` + `Callers that must not substitute should check hasMonument() first.`);
  return REGISTRY[DEFAULT_MONUMENT_ID];
}

/** True when `id` names a monument we actually hold. No fallback, no side effect. */
export function hasMonument(id: string | null | undefined): boolean {
  return Boolean(id && Object.prototype.hasOwnProperty.call(REGISTRY, id));
}

/** Every id, in registry order. Used by the index page and the QR generator. */
export function monumentIds(): string[] {
  return Object.keys(REGISTRY);
}

export function allMonuments(): Monument[] {
  return Object.values(REGISTRY);
}

/** Falls back through the language's voice relative, then English, then any name we hold. */
export function displayName(m: Monument, lang: LangCode): string {
  const code = normalizeLang(lang);
  return (
    m.displayName[code] ??
    m.displayName[info(code).voiceFallback ?? ''] ??
    m.displayName['en-IN'] ??
    Object.values(m.displayName)[0] ??
    m.id
  );
}

export function regionLabel(r: Region, lang: LangCode): string {
  const code = normalizeLang(lang);
  return r.label[code] ?? r.label['en-IN'] ?? r.id;
}

export function findRegion(m: Monument, id: string | null | undefined): Region | null {
  if (!id) return null;
  return m.regions.find((r) => r.id === id) ?? null;
}

export function regionIds(m: Monument): string[] {
  return m.regions.map((r) => r.id);
}
