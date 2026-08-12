/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ow: {
          // Primary accent — Overwatch's own signature orange (base + lighter
          // end for gradients), with tactical cyan as the secondary accent.
          accent: '#F7931E',
          accentLight: '#FFC069',
          blue: '#29D3F2',
          // Surfaces are theme-driven CSS variables (RGB channels for opacity support).
          dark:   'rgb(var(--ow-dark) / <alpha-value>)',
          darker: 'rgb(var(--ow-darker) / <alpha-value>)',
          card:   'rgb(var(--ow-card) / <alpha-value>)',
          border: 'rgb(var(--ow-border) / <alpha-value>)',
        }
      },
      fontFamily: {
        display: ['"Big Shoulders Display"', 'system-ui', 'sans-serif'],
        body: ['Barlow', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      }
    }
  },
  plugins: [],
}
