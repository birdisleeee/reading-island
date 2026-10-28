package site.nyachu.reading;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** No WebView bridge: only native user actions can download or launch an installer. */
public final class AppUpdater {
    private static final int INSTALL_PERMISSION=904;
    private final Activity activity;
    private final String base;
    private final SharedPreferences prefs;
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelled=new AtomicBoolean();
    private volatile HttpURLConnection connection;
    private volatile boolean closed;
    private boolean busy,foreground,manualCheck,pendingInstall,pendingOffer;
    private UpdatePolicy.Info offered,ready;
    private AlertDialog dialog;
    private ProgressDialog progress;
    private final long installed;
    private final File directory;
    public AppUpdater(Activity activity,String base) {
        this.activity=activity;this.base=base;this.prefs=activity.getSharedPreferences("apk-updates",Context.MODE_PRIVATE);
        directory=new File(activity.getCacheDir(),"updates");directory.mkdirs();
        long code=0;try{code=version(activity.getPackageManager().getPackageInfo(activity.getPackageName(),0));}catch(Exception ignored){}installed=code;
        try{ready=parse(prefs.getString("ready",""));if(ready.versionCode<=installed||!apkFile(ready).isFile())clearReady();}catch(Exception ignored){clearReady();}
    }
    public long installedVersion(){return installed;}
    private long version(PackageInfo p){return Build.VERSION.SDK_INT>=28?p.getLongVersionCode():p.versionCode;}
    private File apkFile(UpdatePolicy.Info info){return new File(directory,info.sha256+".apk");}
    private void clearReady(){if(ready!=null&&ready.versionCode<=installed)apkFile(ready).delete();ready=null;prefs.edit().remove("ready").remove("permissionWaiting").apply();}
    private UpdatePolicy.Info parse(String text) throws Exception {
        JSONObject j=new JSONObject(text);if(j.getInt("schemaVersion")!=1)throw new IOException("Invalid update schema");
        JSONArray notes=j.getJSONArray("notes");if(notes.length()>12)throw new IOException("Invalid release notes");StringBuilder n=new StringBuilder();for(int i=0;i<notes.length();i++){String line=notes.getString(i);if(line.length()>350)throw new IOException("Release note too long");if(i>0)n.append("\n");n.append("• ").append(line);}
        UpdatePolicy.Info info=new UpdatePolicy.Info(base,j.getString("packageName"),j.getLong("versionCode"),j.getString("versionName"),j.getLong("bytes"),j.getString("apkUrl"),j.getString("sha256"),j.getInt("minSdk"),n.toString());
        if(!info.packageName.equals(activity.getPackageName()))throw new IOException("Wrong app");return info;
    }
    private String serialize(UpdatePolicy.Info info) throws Exception {
        JSONObject j=new JSONObject();j.put("schemaVersion",1).put("packageName",info.packageName).put("versionCode",info.versionCode).put("versionName",info.versionName).put("bytes",info.bytes).put("apkUrl",info.apkUrl).put("sha256",info.sha256).put("minSdk",info.minSdk);
        JSONArray notes=new JSONArray();for(String line:info.notes.split("\n"))notes.put(line.replaceFirst("^• ",""));j.put("notes",notes);return j.toString();
    }
    private HttpURLConnection open(String url,int timeout) throws Exception {
        if(closed||cancelled.get())throw new InterruptedIOException("Cancelled");
        HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();connection=c;c.setInstanceFollowRedirects(false);c.setConnectTimeout(10000);c.setReadTimeout(timeout);c.setUseCaches(false);c.setRequestProperty("Accept-Encoding","identity");c.setRequestProperty("Cache-Control","no-cache");
        if(c.getResponseCode()!=200)throw new IOException("Update server unavailable");return c;
    }
    private void disconnect(){HttpURLConnection c=connection;connection=null;if(c!=null)c.disconnect();}
    private void ui(Runnable action){activity.runOnUiThread(()->{if(!closed&&!activity.isFinishing()&&!activity.isDestroyed())action.run();});}
    private void toast(String message){if(foreground)Toast.makeText(activity,message,Toast.LENGTH_LONG).show();}
    public void check(boolean manual) {
        if(closed)return;if(busy){if(manual)toast("正在检查或下载更新，请稍候。");return;}
        if(manual&&ready!=null){offered=ready;manualCheck=true;offer();return;}
        long now=System.currentTimeMillis();if(!manual&&!UpdatePolicy.due(now,prefs.getLong("lastCheck",0),UpdatePolicy.CHECK_INTERVAL))return;
        busy=true;manualCheck=manual;cancelled.set(false);prefs.edit().putLong("lastCheck",now).apply();if(manual)toast("正在检查新版本…");
        executor.execute(()->{try{
            HttpURLConnection c=open(base+"/download/android-update.json",10000);String type=c.getContentType();if(type==null||!type.toLowerCase(Locale.ROOT).startsWith("application/json"))throw new IOException("Invalid update response");
            ByteArrayOutputStream data=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1){if(closed||data.size()+n>65536)throw new IOException("Invalid update response");data.write(b,0,n);}}
            UpdatePolicy.Info info=parse(new String(data.toByteArray(),StandardCharsets.UTF_8));
            ui(()->{busy=false;if(info.versionCode<=installed){if(manual)toast("当前已是最新 APK；网页功能会随服务更新。");return;}if(info.minSdk>Build.VERSION.SDK_INT){if(manual)toast("新版需要更高的 Android 版本，当前仍可继续使用。");return;}if(!manual&&prefs.getLong("laterVersion",0)==info.versionCode&&!UpdatePolicy.due(System.currentTimeMillis(),prefs.getLong("laterAt",0),UpdatePolicy.REMIND_INTERVAL))return;offered=info;if(foreground)offer();else pendingOffer=true;});
        }catch(Exception error){ui(()->{busy=false;if(manual)toast("暂时无法检查更新，请稍后点击“更新”重试。阅读不受影响。");});}finally{disconnect();}});
    }
    private void offer(){
        if(!foreground||offered==null||dialog!=null&&dialog.isShowing())return;
        UpdatePolicy.Info info=offered;String size=String.format(Locale.CHINA,"%.1f MiB",info.bytes/1048576.0);
        dialog=new AlertDialog.Builder(activity).setTitle("发现新版 "+info.versionName).setMessage(info.notes+"\n\n安装包 "+size+"。下载后需在系统页面确认安装，书库和讨论会保留。").setPositiveButton(ready!=null&&ready.sha256.equals(info.sha256)?"继续安装":"下载并更新",(d,w)->download(info)).setNegativeButton("稍后",(d,w)->later(info)).setOnCancelListener(d->later(info)).create();dialog.show();
    }
    private void later(UpdatePolicy.Info info){prefs.edit().putLong("laterVersion",info.versionCode).putLong("laterAt",System.currentTimeMillis()).apply();}
    private void download(UpdatePolicy.Info info){
        if(busy||closed)return;busy=true;cancelled.set(false);
        progress=new ProgressDialog(activity);progress.setTitle("下载新版 "+info.versionName);progress.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);progress.setMax(100);progress.setMessage("正在下载并校验安装包…");progress.setCancelable(false);progress.setButton(DialogInterface.BUTTON_NEGATIVE,"取消下载",(d,w)->{cancelled.set(true);disconnect();});progress.show();
        executor.execute(()->{File part=new File(directory,UUID.randomUUID()+".part.apk");try{
            File target=apkFile(info);
            if(target.isFile()){try{verifyFile(target,info);}catch(Exception invalid){target.delete();}}
            if(!target.isFile()){
                HttpURLConnection c=open(info.apkUrl,20000);long declared=c.getContentLengthLong();if(declared>=0&&declared!=info.bytes)throw new IOException("APK size changed");long started=System.nanoTime();final int[] percent={-1};
                try(InputStream in=c.getInputStream();FileOutputStream out=new FileOutputStream(part)){
                    UpdatePolicy.copyVerified(in,out,info,cancelled,total->{if(System.nanoTime()-started>180L*1000000000)throw new DownloadDeadline();int p=(int)(total*100/info.bytes);if(p!=percent[0]){percent[0]=p;ui(()->{if(progress!=null)progress.setProgress(p);});}});out.getFD().sync();
                }
                verifyPackage(part,info);if(closed||cancelled.get())throw new InterruptedIOException("Cancelled");if(!part.renameTo(target))throw new IOException("Cannot save verified update");
            }
            if(closed||cancelled.get())throw new InterruptedIOException("Cancelled");
            String record=serialize(info);
            ui(()->{busy=false;dismissProgress();ready=info;prefs.edit().putString("ready",record).apply();if(foreground)install();else pendingInstall=true;});
        }catch(Exception error){ui(()->{busy=false;dismissProgress();if(!cancelled.get()&&foreground){dialog=new AlertDialog.Builder(activity).setTitle("更新未完成").setMessage("下载中断或安装包未通过校验，尚未安装任何更新。可点击“更新”重试，或继续阅读。").setPositiveButton("知道了",null).create();dialog.show();}});}finally{part.delete();disconnect();}});
    }
    private static final class DownloadDeadline extends RuntimeException {}
    private void verifyFile(File file,UpdatePolicy.Info info) throws Exception {try(InputStream in=new FileInputStream(file)){UpdatePolicy.copyVerified(in,new OutputStream(){public void write(int b){}public void write(byte[] b,int o,int n){}},info,cancelled,n->{});}verifyPackage(file,info);}
    private void verifyPackage(File file,UpdatePolicy.Info info) throws Exception {
        PackageManager pm=activity.getPackageManager();int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo archive=pm.getPackageArchiveInfo(file.getAbsolutePath(),flags),current=pm.getPackageInfo(activity.getPackageName(),flags);
        if(archive==null||!info.packageName.equals(archive.packageName)||version(archive)!=info.versionCode||version(archive)<=installed||archive.applicationInfo==null||archive.applicationInfo.minSdkVersion>Build.VERSION.SDK_INT)throw new IOException("Wrong APK identity");
        if(!signers(archive).equals(signers(current))||signers(current).isEmpty())throw new IOException("Wrong APK signing certificate");
    }
    private Set<String> signers(PackageInfo info) throws Exception {Signature[] values=Build.VERSION.SDK_INT>=28?(info.signingInfo==null?null:info.signingInfo.getApkContentsSigners()):info.signatures;Set<String> hashes=new HashSet<>();if(values!=null)for(Signature value:values)hashes.add(UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray())));return hashes;}
    private void install(){
        if(ready==null||busy||!foreground)return;
        if(!activity.getPackageManager().canRequestPackageInstalls()){
            dialog=new AlertDialog.Builder(activity).setTitle("允许安装共读岛更新").setMessage("请在接下来的系统设置中允许共读岛安装应用。返回后会打开系统安装确认，你也可以取消并继续阅读。").setPositiveButton("去允许",(d,w)->{prefs.edit().putBoolean("permissionWaiting",true).apply();try{activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName())),INSTALL_PERMISSION);}catch(Exception error){prefs.edit().remove("permissionWaiting").apply();toast("无法打开安装授权设置，请稍后重试。");}}).setNegativeButton("暂不安装",null).create();dialog.show();return;
        }
        busy=true;cancelled.set(false);UpdatePolicy.Info info=ready;
        executor.execute(()->{try{verifyFile(apkFile(info),info);ui(()->{busy=false;dismissProgress();if(!foreground){pendingInstall=true;return;}Uri uri=new Uri.Builder().scheme("content").authority(activity.getPackageName()+".updates").appendPath("apk").appendPath(info.sha256+".apk").build();Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);try{activity.startActivity(intent);}catch(Exception error){toast("无法打开系统安装程序，请稍后重试或从官网下载新版。");}});}catch(Exception error){ui(()->{busy=false;clearReady();toast("安装包已失效，请重新检查并下载更新。");});}});
    }
    private void dismissProgress(){if(progress!=null){progress.dismiss();progress=null;}}
    public void resume(){foreground=true;if(prefs.getBoolean("permissionWaiting",false)){prefs.edit().remove("permissionWaiting").apply();if(activity.getPackageManager().canRequestPackageInstalls())install();else toast("尚未允许安装。需要时可点击“更新”重试。");}else if(pendingInstall){pendingInstall=false;install();}else if(pendingOffer){pendingOffer=false;offer();}else check(false);}
    public void pause(){foreground=false;}
    public void close(){closed=true;cancelled.set(true);disconnect();executor.shutdownNow();dismissProgress();if(dialog!=null)dialog.dismiss();}
}
