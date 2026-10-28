import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Stage the signed APK and its generated manifest as one reviewed release pair.
export async function stageAndroidRelease({apk,metadata,assets}){
  const bytes=await readFile(apk),info=JSON.parse(await readFile(metadata,'utf8'));
  const manifest=await readFile(new URL('../android-app/AndroidManifest.xml',import.meta.url),'utf8');
  if(info.schemaVersion!==1||info.packageName!=='site.nyachu.reading'||info.versionCode!==Number(manifest.match(/versionCode="(\d+)"/)[1])||info.versionName!==manifest.match(/versionName="([^"]+)"/)[1]||info.bytes!==bytes.length||bytes.length>32*1048576||bytes.length<1||info.sha256!==createHash('sha256').update(bytes).digest('hex')||!/^[a-f0-9]{64}$/.test(info.signerSha256)||info.apkUrl!==`https://reading.nyachu.site/download/app.apk?version=${info.versionCode}`||info.minSdk!==26||!Array.isArray(info.notes)||info.notes.length<1||info.notes.length>12||info.notes.some(n=>typeof n!=='string'||n.length>350))throw Error('APK and update metadata do not describe the reviewed Android release');
  const dir=resolve(assets,'download');await mkdir(dir,{recursive:true});
  await copyFile(apk,resolve(dir,'reading-island.apk'));await writeFile(resolve(dir,'android-update.json'),JSON.stringify(info,null,2)+'\n');return info;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [apk,metadata,assets]=process.argv.slice(2);if(!apk||!metadata||!assets)throw Error('Usage: node tools/stage-android-release.mjs APK GENERATED_METADATA ASSETS_DIRECTORY');
  const info=await stageAndroidRelease({apk,metadata,assets});console.log(`Staged Android ${info.versionName} (${info.versionCode}), ${info.bytes} bytes; verify signing certificate with apksigner before publishing.`);
}
