/** @type {import('tailwindcss').Config} */
// theme.css keys everything off [data-theme="dark"] on <html> (set by the
// no-flash bootstrap in index.html, mirrored by hooks/useTheme.js). Point
// Tailwind's dark: variant at the same selector — this replaces the inline
// `tailwind.config = { darkMode: … }` that PipeWise fed the CDN build.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {},
  },
  plugins: [],
}
