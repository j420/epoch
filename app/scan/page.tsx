import type { Metadata } from 'next';

import ScanClient from '@/components/scan/ScanClient';
import { isConfigured } from '@/lib/sarvam';

/**
 * /scan — the live camera way in.
 *
 * `isConfigured()` is resolved HERE, on the server, and handed down as a plain
 * boolean. Two reasons that matters:
 *
 *   1. lib/sarvam is server-only and the key must never cross to the browser.
 *      A client component asking "is there a key?" would have to burn a real
 *      identify call to find out, which is exactly the kind of wasted request
 *      this feature is built to avoid.
 *   2. The visitor learns that recognition is unavailable BEFORE they are asked
 *      to hand over their camera. Asking for a camera permission we cannot use
 *      would be dishonest.
 *
 * `force-dynamic` because the answer depends on the environment at request
 * time, not at build time.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Bol — point your camera at a monument',
  description:
    'Hold your phone up to an Indian monument and Bol recognises it, then lets you talk to it in any of 22 languages.',
};

export default function ScanPage() {
  return <ScanClient configured={isConfigured()} />;
}
