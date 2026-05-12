import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'fs/promises';

const isWatch = process.argv.includes('--watch');

// Load .env if present, then fall back to process.env
try {
  const envFile = await readFile('.env', 'utf8');
  for (const line of envFile.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
} catch { /* no .env — that's fine */ }

const workerUrl = process.env.WORKER_URL ?? 'https://clicky-proxy.REPLACE_SUBDOMAIN.workers.dev';
const clickyApiKey = process.env.CLICKY_API_KEY ?? '';
const disableAudio = process.env.DISABLE_AUDIO === 'true';

await mkdir('dist', { recursive: true });

const buildOptions = {
  bundle: true,
  format: /** @type {const} */ ('iife'),
  target: 'chrome116',
  outdir: 'dist',
  sourcemap: isWatch ? 'inline' : false,
  logLevel: /** @type {const} */ ('info'),
  define: {
    WORKER_URL: JSON.stringify(workerUrl),
    CLICKY_API_KEY: JSON.stringify(clickyApiKey),
    DISABLE_AUDIO: JSON.stringify(disableAudio),
  },
};

const entryPoints = [
  { in: 'src/background.ts', out: 'background' },
  { in: 'src/content.ts',    out: 'content' },
  { in: 'src/popup.ts',      out: 'popup' },
  { in: 'src/offscreen.ts',  out: 'offscreen' },
];

if (isWatch) {
  const ctx = await esbuild.context({ ...buildOptions, entryPoints });
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build({ ...buildOptions, entryPoints });
  await cp('src/styles.css', 'dist/styles.css');
  await cp('popup.html', 'dist/popup.html');
  await cp('offscreen.html', 'dist/offscreen.html');
  await cp('icons', 'dist/icons', { recursive: true });

  // Write a dist-corrected manifest: strip "dist/" prefix from all asset paths
  const manifest = (await readFile('manifest.json', 'utf8')).replace(/dist\//g, '');
  await writeFile('dist/manifest.json', manifest);

  console.log('Build complete → dist/');
}
