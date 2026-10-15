import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
const excluded=new Set(['.git','node_modules','dist','.wrangler','.dev.vars','.agent-data','android-app/build','docs/PREPARATION.md']);
const rules=[/C:[\\/]Users[\\/]/i,/isles-story\.site|TOKEN_HERMES|TOKEN_ISLE|HERMES_WEBHOOK_URL|isles_token|桔小鸟|小初|沈初/,/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9]{32,}/];
let count=0;
async function walk(dir='.'){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const file=join(dir,entry.name),rel=relative('.',file).replaceAll('\\','/');
    if(excluded.has(entry.name)||excluded.has(rel)||entry.name.endsWith('.log'))continue;
    if(entry.isDirectory()){await walk(file);continue;}
    if(/\.(db|sqlite|sqlite3|epub|bundle|zip|tar|pem|jks|keystore|apk)$/.test(rel))throw new Error(`Disallowed release file: ${rel}`);
    if(rel==='tools/check-release.mjs')continue;
    const text=await readFile(file,'utf8');
    for(const rule of rules)if(rule.test(text))throw new Error(`Private identifier or credential pattern in ${rel}`);
    count++;
  }
}
await walk();console.log(`Release content check passed: ${count} files; no private paths, identity configuration or credential patterns.`);
