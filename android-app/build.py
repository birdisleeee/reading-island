"""Build a dependency-free signed Android APK using SDK build-tools and JDK 17.
Signing secrets are environment inputs, never repository files.
"""
import os,pathlib,subprocess,zipfile,shutil,json,hashlib,re,xml.etree.ElementTree as ET
ROOT=pathlib.Path(__file__).resolve().parent
SDK=pathlib.Path(os.environ['ANDROID_SDK_ROOT']);PLATFORM=pathlib.Path(os.environ.get('ANDROID_PLATFORM_JAR',str(SDK/'platforms/android-35/android.jar')))
TOOLS=pathlib.Path(os.environ.get('ANDROID_BUILD_TOOLS',str(SDK/'build-tools/35.0.0')))
KEYSTORE=pathlib.Path(os.environ['APK_KEYSTORE']);ALIAS=os.environ.get('APK_KEY_ALIAS','reading-island')
def run(*a):subprocess.run([str(v) for v in a],check=True,cwd=ROOT)
build=ROOT/'build';build.mkdir(exist_ok=True);classes=build/'classes';dex=build/'dex'
for directory in (classes,dex):
 if directory.exists():shutil.rmtree(directory)
 directory.mkdir()
run(TOOLS/'aapt2','compile','--dir',ROOT/'res','-o',build/'resources.zip')
run(TOOLS/'aapt2','link','-o',build/'base.apk','-I',PLATFORM,'--manifest',ROOT/'AndroidManifest.xml',build/'resources.zip')
run('javac','-encoding','UTF-8','-source','8','-target','8','-classpath',PLATFORM,'-d',classes,*ROOT.glob('src/**/*.java'))
jar=build/'classes.jar'
with zipfile.ZipFile(jar,'w') as z:
 for p in classes.rglob('*.class'):z.write(p,str(p.relative_to(classes)))
run(TOOLS/'d8','--lib',PLATFORM,'--min-api','26','--output',dex,jar)
unsigned=build/'unsigned.apk';shutil.copyfile(build/'base.apk',unsigned)
with zipfile.ZipFile(unsigned,'a',zipfile.ZIP_DEFLATED) as z:
 for p in dex.glob('*.dex'):z.write(p,p.name)
run(TOOLS/'zipalign','-f','4',unsigned,build/'aligned.apk')
run(TOOLS/'apksigner','sign','--ks',KEYSTORE,'--ks-key-alias',ALIAS,'--ks-pass','env:APK_STORE_PASSWORD','--key-pass','env:APK_KEY_PASSWORD','--out',build/'reading-island.apk',build/'aligned.apk')
run(TOOLS/'apksigner','verify','--verbose',build/'reading-island.apk')
apk=build/'reading-island.apk'
certificate=subprocess.check_output([str(TOOLS/'apksigner'),'verify','--print-certs',str(apk)],text=True,cwd=ROOT)
signer=re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)',certificate)
assert signer,'Missing signing certificate'
manifest=ET.parse(ROOT/'AndroidManifest.xml').getroot();android='{http://schemas.android.com/apk/res/android}'
version=int(manifest.attrib[android+'versionCode']);name=manifest.attrib[android+'versionName']
base=re.search(r'BASE_URL\s*=\s*"(https://[^"/]+)"',(ROOT/'src/site/nyachu/reading/MainActivity.java').read_text()).group(1)
notes=json.loads((ROOT/'release-notes.json').read_text(encoding='utf-8'))['notes']
assert 0<len(notes)<=12 and all(isinstance(n,str) and 0<len(n)<=350 for n in notes)
assert sum(len(n)+3 for n in notes)<=3000 and 0<version<=2147483647 and re.fullmatch(r'[0-9A-Za-z][0-9A-Za-z. _-]{0,39}',name)
metadata={'schemaVersion':1,'packageName':manifest.attrib['package'],'versionCode':version,'versionName':name,'minSdk':26,'apkUrl':base+'/download/app.apk?version='+str(version),'bytes':apk.stat().st_size,'sha256':hashlib.sha256(apk.read_bytes()).hexdigest(),'signerSha256':signer.group(1).lower(),'notes':notes}
(build/'android-update.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
print('SIGNED APK:',build/'reading-island.apk')
