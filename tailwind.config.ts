import type { Config } from 'tailwindcss';

/**
 * Bol's palette is sandstone and night — the colours of the monument itself.
 * The UI is deliberately almost invisible: the photograph is the interface.
 *
 * Motion is deliberately small: three durations (`fast` / `base` / `slow`) and
 * one house curve (`bol`), so every transition in the product feels like it
 * belongs to the same object. Nothing bounces; things leave quickly and settle
 * slowly, the way something heavy comes to rest. All of it is disabled by the
 * `prefers-reduced-motion` block in globals.css.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sandstone: {
          50: '#fdf6ef',
          100: '#f8e6d4',
          200: '#efc8a4',
          300: '#e2a271',
          400: '#d47f4c',
          500: '#c1622f',
          600: '#a24a24',
          700: '#7d3720',
          800: '#5a2819',
          900: '#3a1a11',
        },
        night: {
          800: '#12100e',
          900: '#0a0908',
          950: '#050403',
        },
      },
      fontFamily: {
        // Platform Latin first, then every Indic family a real device is likely
        // to already hold. Defined as CSS custom properties in globals.css so
        // there is exactly one place to change the stack.
        sans: ['var(--font-body)'],
        indic: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        // Display sizes for the gallery and the dashboard. Tight tracking is
        // safe here because Indic strings carry `.indic-text`, which resets
        // letter-spacing to 0 — see globals.css.
        display: ['clamp(2rem, 7vw, 2.75rem)', { lineHeight: '1.06', letterSpacing: '-0.025em' }],
        figure: ['clamp(3.25rem, 15vw, 4.5rem)', { lineHeight: '0.92', letterSpacing: '-0.04em' }],
      },
      transitionTimingFunction: {
        bol: 'cubic-bezier(0.22, 0.75, 0.24, 1)',
        'bol-soft': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      transitionDuration: {
        fast: '140ms',
        base: '260ms',
        slow: '560ms',
      },
      animation: {
        breathe: 'breathe 4s ease-in-out infinite',
        'listen-pulse': 'listen-pulse 1.4s ease-in-out infinite',
        shimmer: 'shimmer 2.4s linear infinite',
        // The house entrances. One rise, one fade, one sheet.
        rise: 'rise var(--bol-slow, 560ms) cubic-bezier(0.22, 0.75, 0.24, 1) both',
        'fade-in': 'fadeIn var(--bol-base, 260ms) cubic-bezier(0.22, 0.75, 0.24, 1) both',
        sheet: 'sheet var(--bol-base, 260ms) cubic-bezier(0.22, 0.75, 0.24, 1) both',
        'pool-in': 'poolIn var(--bol-slow, 560ms) cubic-bezier(0.22, 0.75, 0.24, 1) both',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.85' },
          '50%': { transform: 'scale(1.04)', opacity: '1' },
        },
        'listen-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(226,162,113,0.45)' },
          '70%': { boxShadow: '0 0 0 22px rgba(226,162,113,0)' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        rise: {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        sheet: {
          '0%': { opacity: '0', transform: 'translateY(18px) scale(0.985)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        poolIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
