// ESM (package.json has "type": "module") — Vite loads this for every
// CSS file and runs Tailwind + vendor prefixing at build time. The old
// PipeWise Tailwind CDN <script> is gone; theme.css's @tailwind
// directives are compiled here instead.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
