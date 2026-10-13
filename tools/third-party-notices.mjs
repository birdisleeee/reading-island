import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
const root=resolve('.'),seen=new Set();
let output='# Third-party notices\n\nProject code, original SVG assets and the original sample book are MIT licensed. Third-party code retains the following licenses. npm-installed development tools retain their own packaged licenses and are not vendored here.\n\n## Marked\n\n'+await readFile('web/vendor/marked.LICENSE.md','utf8');
async function locate(name,start){let current=start;while(current.startsWith(root)){const candidate=join(current,'node_modules',name);try{await readFile(join(candidate,'package.json'));return candidate;}catch{}if(current===root)break;current=dirname(current);}throw new Error('Dependency not found: '+name);}
async function collect(name,start=root){
 const directory=await locate(name,start),info=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
 const key=info.name+'@'+info.version;if(seen.has(key))return;seen.add(key);
 output+=`\n\n## ${key}\n\nLicense: ${info.license || 'See packaged license'}\n\n`;
 const files=(await readdir(directory)).filter(name=>/^(license|copying)(\.|$)/i.test(name));
 if(!files.length)throw new Error('Missing packaged license: '+key);
 for(const file of files)output+='```text\n'+(await readFile(join(directory,file),'utf8')).trim()+'\n```\n';
 for(const child of Object.keys(info.dependencies||{}))await collect(child,directory);
}
await collect('linkedom');await writeFile('THIRD_PARTY_NOTICES.md',output+'\n');console.log(`Preserved Marked and ${seen.size} runtime dependency notices.`);
