import Stage from '@/components/Stage';
import { getMonument, DEFAULT_MONUMENT_ID } from '@/lib/monuments';

export const dynamic = 'force-static';

/**
 * The one URL a QR code points at.
 *
 * The monument is resolved on the server so the photograph, its regions and its
 * greetings are in the first HTML payload — a visitor on 4G should see the image
 * begin to load before any JavaScript has run.
 */
export default function Home() {
  const monument = getMonument(DEFAULT_MONUMENT_ID);
  return <Stage monument={monument} />;
}
