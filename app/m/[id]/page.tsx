import { notFound } from 'next/navigation';

import Stage from '@/components/Stage';
import { getMonument, hasMonument, monumentIds, displayName } from '@/lib/monuments';

/**
 * One monument, one URL — this is what a QR code at a site actually points at.
 *
 * `/` remains Qutub Minar so the original QR codes keep working; every other
 * monument lives here. An unknown id 404s rather than silently substituting the
 * default, because a visitor standing at Charminar being told about Qutub Minar
 * is worse than an honest "not found".
 */
export function generateStaticParams() {
  return monumentIds().map((id) => ({ id }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { id: string } }) {
  if (!hasMonument(params.id)) return { title: 'Bol' };
  const monument = getMonument(params.id);
  const name = displayName(monument, 'en-IN');
  return {
    title: `${name} — speak to it | Bol`,
    description: `Talk to ${name} in any of 22 Indian languages. It answers in yours.`,
  };
}

export default function MonumentPage({ params }: { params: { id: string } }) {
  if (!hasMonument(params.id)) notFound();
  return <Stage monument={getMonument(params.id)} />;
}
