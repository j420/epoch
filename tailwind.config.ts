import type { Config } from 'tailwindcss';

/**
 * Bol's palette is sandstone and night — the colours of the monument itself.
 * The UI is deliberately almost invisible: the photograph is the interface.
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
        // Noto covers every Indian script we may need to render.
        indic: ['var(--font-indic)', 'Noto Sans', 'Noto Sans Devanagari', 'Noto Sans Tamil', 'system-ui', 'sans-serif'],
      },
      animation: {
        'breathe': 'breathe 4s ease-in-out infinite',
        'listen-pulse': 'listen-pulse 1.4s ease-in-out infinite',
        'shimmer': 'shimmer 2.4s linear infinite',
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
