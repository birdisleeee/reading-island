import {build} from 'esbuild';
import {mkdir,cp} from 'node:fs/promises';
await mkdir('dist/assets/service',{recursive:true});
for(const name of ['index.html','portal.css','portal.mjs'])await cp('public-service/'+name,'dist/assets/service/'+name);
await build({entryPoints:['public-service/worker.mjs'],outfile:'dist/public-worker.mjs',bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
console.log('Built optional public service; self-hosted Worker remains separate.');
