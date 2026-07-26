import { isConfigured } from '@/lib/sarvam';
import { isDubEnabled } from '@/lib/dub';
import GuideClient from './GuideClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Bol — Guide Amplifier',
  description: 'One guide speaks. Everyone hears it in their own language, in the guide’s own voice.',
};

/**
 * Server shell. It reads configuration here — a server component may import
 * lib/sarvam, a client component may not — and hands the answer down as a prop so the
 * page can explain itself honestly before anyone presses anything.
 */
export default function GuidePage() {
  return <GuideClient sarvamConfigured={isConfigured()} dubEnabled={isDubEnabled()} />;
}
