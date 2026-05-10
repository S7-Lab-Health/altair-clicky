import * as esbuild from 'esbuild';
import { cp, mkdir } from 'fs/promises';

const isWatch = process.argv.includes('--watch');

// WORKER_URL can be overridden at build time via environment variable:
//   WORKER_URL=https://my-worker.workers.dev npm run build
const workerUrl = process.env.WORKER_URL ?? 'https://clicky-proxy.REPLACE_SUBDOMAIN.workers.dev';

await mkdir('dist', { recursive: true });

const buildOptions = {
  bundle: true,
  format: /** @type {const} */ ('iife'),
  target: 'chrome116',
  sourcemap: isWatch ? 'inline' : false,
  logLevel: /** @type {const} */ ('info'),
  define: {
    WORKER_URL: JSON.stringify(workerUrl),
  },
};

const entryPoints = [
  { in: 'src/background.ts', out: 'dist/background' },
  { in: 'src/content.ts',    out: 'dist/content' },
  { in: 'src/popup.ts',      out: 'dist/popup' },
  { in: 'src/offscreen.ts',  out: 'dist/offscreen' },
];

if (isWatch) {
  const ctx = await esbuild.context({ ...buildOptions, entryPoints });
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build({ ...buildOptions, entryPoints });
  await cp('src/styles.css', 'dist/styles.css');
  console.log('Build complete → dist/');
}
