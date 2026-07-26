import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bol — speak to a monument',
  description:
    'Scan, speak, and a monument answers you in your own language. No app. No language picker. Bol listens in 22 Indian languages.',
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'Bol — speak to a monument',
    description: 'A monument that listens in 22 Indian languages and remembers what you tell it.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0908',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // The visual layer is a full-bleed photograph; pinch-zoom would break the parallax.
  userScalable: false,
  viewportFit: 'cover',
};

/**
 * No `next/font` anywhere: there is no network at build time, so every Google
 * font import fails the build and every self-hosted file would blow the page
 * weight budget. The type stack is system + resident Noto, declared once in
 * globals.css as `--font-body`. See the Indic typography block there.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-night-900 font-sans antialiased">{children}</body>
    </html>
  );
}
