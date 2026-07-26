import type { Metadata } from 'next';

import CreateClient from './CreateClient';

/**
 * Talk to your own photograph.
 *
 * Nothing on this route can be rendered on the server: the photograph never
 * leaves the visitor's device, the depth model runs in their browser, and the
 * whole thing is restored from their IndexedDB. So the page itself is a shell
 * and every decision lives in `CreateClient`.
 */

export const metadata: Metadata = {
  title: 'Bol — talk to your own photograph',
  description:
    'Photograph any building or statue and talk to it. It will tell you what it looks like, and admit that it does not know its own history.',
};

export default function CreatePage() {
  return <CreateClient />;
}
