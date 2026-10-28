package site.nyachu.reading;

import java.io.*;
import java.net.URI;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

/** Platform-independent bounds, identities and stream verification. */
public final class UpdatePolicy {
    public static final long MAX_APK_BYTES=32L*1024*1024;
    public static final long CHECK_INTERVAL=6L*60*60*1000, REMIND_INTERVAL=24L*60*60*1000;
    public static final class Info {
        public final long versionCode,bytes;
        public final int minSdk;
        public final String packageName,versionName,apkUrl,sha256,notes;
        public Info(String base,String pkg,long code,String name,long size,String url,String sha,int sdk,String notes) throws Exception {
            URI origin=new URI(base),apk=new URI(url);
            if(!"https".equals(origin.getScheme())||origin.getHost()==null||origin.getRawUserInfo()!=null||origin.getRawQuery()!=null||origin.getRawFragment()!=null||!(origin.getRawPath().isEmpty()||origin.getRawPath().equals("/"))||(origin.getPort()!=-1&&origin.getPort()!=443))throw new IOException("Invalid update origin");
            if(code<1||code>Integer.MAX_VALUE||size<1||size>MAX_APK_BYTES||sdk<26||sdk>100||name==null||!name.matches("[0-9A-Za-z][0-9A-Za-z. _-]{0,39}")||pkg==null||!pkg.matches("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+")||sha==null||!sha.matches("[a-f0-9]{64}")||notes==null||notes.length()>3000)throw new IOException("Invalid update information");
            String expected=base.replaceAll("/$","")+"/download/app.apk?version="+code;
            if(!url.equals(expected)||!"https".equals(apk.getScheme()))throw new IOException("Invalid update URL");
            packageName=pkg;versionCode=code;versionName=name;bytes=size;apkUrl=url;sha256=sha;minSdk=sdk;this.notes=notes;
        }
    }
    public static boolean due(long now,long last,long interval){return last<=0||now<last||now-last>=interval;}
    public static boolean checkLink(String base,String url,boolean mainFrame,boolean userGesture){return mainFrame&&userGesture&&(base+"/native/check-update").equals(url);}
    public interface Progress {void update(long bytes);}
    public static void copyVerified(InputStream input,OutputStream output,Info info,AtomicBoolean cancelled,Progress progress) throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[16384];long total=0;int n;
        while((n=input.read(buffer))!=-1){if(cancelled.get()||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Cancelled");total+=n;if(total>info.bytes||total>MAX_APK_BYTES)throw new IOException("APK size mismatch");output.write(buffer,0,n);digest.update(buffer,0,n);progress.update(total);}
        if(cancelled.get()||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Cancelled");
        if(total!=info.bytes||!hex(digest.digest()).equals(info.sha256))throw new IOException("APK integrity mismatch");
    }
    public static String hex(byte[] bytes){StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
}
