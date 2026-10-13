import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
await mkdir('dist/assets/reading-island', { recursive: true });
await build({ entryPoints: ['web/app.mjs'], outfile: 'dist/assets/reading-island/app.mjs', bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
for (const name of ['index.html','reading.css','details.css','ai-settings.css']) await writeFile(`dist/assets/reading-island/${name}`, await readFile(`web/${name}`));
await cp('web/assets', 'dist/assets/reading-island/assets', { recursive: true });
await build({ entryPoints: ['src/cloudflare/entry.mjs'], outfile: 'dist/worker.mjs', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
console.log('Built independent UI and Cloudflare reference backend.');
