/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ow: {
          // Primary accent — electric violet (base + lighter end for gradients).
          accent: '#8B5CF6',
          accentLight: '#C4B5FD',
          blue: '#4DB9E7',
          // Surfaces are theme-driven CSS variables (RGB channels for opacity support).
          dark:   'rgb(var(--ow-dark) / <alpha-value>)',
          darker: 'rgb(var(--ow-darker) / <alpha-value>)',
          card:   'rgb(var(--ow-card) / <alpha-value>)',
          border: 'rgb(var(--ow-border) / <alpha-value>)',
        }
      }
    }
  },
  plugins: [],
}
