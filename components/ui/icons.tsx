/**
 * The whole icon set, hand-drawn as inline SVG.
 *
 * No icon font, no sprite, no dependency — the page weight budget is tight and
 * every one of these is under 200 bytes. They share a single grammar: a 24px
 * box, 1.6px round-capped strokes, `currentColor`, and no fills, so they sit at
 * the same optical weight as the text beside them at any size.
 *
 * Every one is `aria-hidden`. These are never the only label for a control —
 * the button carries the words or an `aria-label`.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 20, className = '', children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/** A viewfinder with a lens — "point your camera at a monument". */
export function IconViewfinder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8.5V6a3 3 0 0 1 3-3h2.5M15.5 3H18a3 3 0 0 1 3 3v2.5M21 15.5V18a3 3 0 0 1-3 3h-2.5M8.5 21H6a3 3 0 0 1-3-3v-2.5" />
      <circle cx="12" cy="12" r="3.4" />
    </Svg>
  );
}

/** A circled 'i' — the photograph's own caption. */
export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.75" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A crack through a wall — "report damage". */
export function IconCrack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l-2.2 5.4 3.4 1.6-2.6 4.2 2.6 1-3.2 6.8" />
      <path d="M4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14" opacity="0.5" />
    </Svg>
  );
}

/** A globe with meridians — "languages I speak". */
export function IconTongues(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.4 2.5 3.6 5.4 3.6 8.5S14.4 18 12 20.5C9.6 18 8.4 15.1 8.4 12S9.6 6 12 3.5z" />
    </Svg>
  );
}

/** Three dots — the one restrained affordance that holds everything secondary. */
export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Speech lines — show the transcript. */
export function IconTranscript(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M4 11h11M4 16h7" />
    </Svg>
  );
}

/** Speech lines, struck through — hide the transcript. */
export function IconTranscriptOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M4 11h11M4 16h7" opacity="0.55" />
      <path d="M3.5 20.5L20.5 3.5" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

/** A right-pointing chevron for list rows. */
export function IconChevron(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

/** An envelope-ish postcard — "take me with you". */
export function IconPostcard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M14 9h4M14 12.5h4" />
      <circle cx="8.5" cy="10.5" r="2" />
      <path d="M5 15.5c.8-1.4 2-2.1 3.5-2.1s2.7.7 3.5 2.1" />
    </Svg>
  );
}
