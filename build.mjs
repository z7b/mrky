import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'fs';
import path from 'path';

const DIST = 'dist';
const isWatch = process.argv.includes('--watch');

const dirs = [
  DIST,
  `${DIST}/popup`,
  `${DIST}/player`,
  `${DIST}/review`,
  `${DIST}/offscreen`,
  `${DIST}/pdf-reader`,
  `${DIST}/pdfjs`,
  `${DIST}/icons`,
];
dirs.forEach(d => mkdirSync(d, { recursive: true }));

// --- Bundle JS ---
const commonOptions = {
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch,
  target: ['chrome110'],
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
  },
};

// Content script (IIFE — injected into web pages, no ES modules allowed)
const contentBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/content/main.js'],
  outfile: `${DIST}/content.js`,
  format: 'iife',
});

// Background service worker (IIFE for maximum compatibility)
const bgBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/background/service-worker.js'],
  outfile: `${DIST}/service-worker.js`,
  format: 'iife',
});

// Popup page
const popupBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/popup/main.js'],
  outfile: `${DIST}/popup/main.js`,
  format: 'iife',
});

// Local Player page
const playerBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/player/main.js'],
  outfile: `${DIST}/player/main.js`,
  format: 'iife',
});

// Review page
const reviewBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/review/main.js'],
  outfile: `${DIST}/review/main.js`,
  format: 'iife',
});

// Offscreen audio document
const offscreenBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/offscreen/main.js'],
  outfile: `${DIST}/offscreen/main.js`,
  format: 'iife',
});

// PDF Reader page
const pdfReaderBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/pdf-reader/main.js'],
  outfile: `${DIST}/pdf-reader/main.js`,
  format: 'iife',
});

await Promise.all([contentBuild, bgBuild, popupBuild, playerBuild, reviewBuild, offscreenBuild, pdfReaderBuild]);

// --- Copy static files ---
copyFileSync('public/manifest.json', `${DIST}/manifest.json`);
copyFileSync('src/content/styles.css', `${DIST}/content.css`);
copyFileSync('src/popup/index.html', `${DIST}/popup/index.html`);
copyFileSync('src/popup/styles.css', `${DIST}/popup/styles.css`);
copyFileSync('src/player/index.html', `${DIST}/player/index.html`);
copyFileSync('src/player/styles.css', `${DIST}/player/styles.css`);
copyFileSync('src/review/index.html', `${DIST}/review/index.html`);
copyFileSync('src/review/styles.css', `${DIST}/review/styles.css`);
copyFileSync('src/offscreen/index.html', `${DIST}/offscreen/index.html`);
copyFileSync('src/pdf-reader/index.html', `${DIST}/pdf-reader/index.html`);
copyFileSync('src/pdf-reader/styles.css', `${DIST}/pdf-reader/styles.css`);

// Copy pdfjs library files
if (existsSync('public/pdfjs')) {
  cpSync('public/pdfjs', `${DIST}/pdfjs`, { recursive: true });
}

// Copy icons
if (existsSync('public/icons')) {
  cpSync('public/icons', `${DIST}/icons`, { recursive: true });
}

// Copy Tesseract dependencies
if (existsSync('public/tesseract')) {
  cpSync('public/tesseract', `${DIST}/tesseract`, { recursive: true });
}

console.log('✅ Mrky Extension built successfully → dist/');
