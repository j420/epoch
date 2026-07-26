import qutub from '@/content/qutub-minar.json';
import type { Monument, Region } from './types';
import { info, normalizeLang, type LangCode } from './langs';

/**
 * Monument content registry. Statically imported so it works in edge runtimes,
 * in the service worker precache manifest, and offline.
 */
const REGISTRY: Record<string, Monument> = {
  'qutub-minar': qutub as Monument,
};

export const DEFAULT_MONUMENT_ID = 'qutub-minar';

export function getMonument(id: string = DEFAULT_MONUMENT_ID): Monument {
  return REGISTRY[id] ?? REGISTRY[DEFAULT_MONUMENT_ID];
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
