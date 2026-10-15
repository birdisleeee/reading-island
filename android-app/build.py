"""Build a dependency-free signed Android APK using SDK build-tools and JDK 17.
Signing secrets are environment inputs, never repository files.
"""
import os,pathlib,subprocess,zipfile,shutil
ROOT=pathlib.Path(__file__).resolve().parent
SDK=pathlib.Path(os.environ['ANDROID_SDK_ROOT']);PLATFORM=pathlib.Path(os.environ.get('ANDROID_PLATFORM_JAR',str(SDK/'platforms/android-35/android.jar')))
TOOLS=pathlib.Path(os.environ.get('ANDROID_BUILD_TOOLS',str(SDK/'build-tools/35.0.0')))
KEYSTORE=pathlib.Path(os.environ['APK_KEYSTORE']);ALIAS=os.environ.get('APK_KEY_ALIAS','reading-island')
def run(*a):subprocess.run([str(v) for v in a],check=True,cwd=ROOT)
build=ROOT/'build';build.mkdir(exist_ok=True);classes=build/'classes';classes.mkdir(exist_ok=True);dex=build/'dex';dex.mkdir(exist_ok=True)
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
print('SIGNED APK:',build/'reading-island.apk')
