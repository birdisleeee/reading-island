package site.nyachu.reading;
import java.io.*;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

public final class UpdatePolicyTest {
    private static int checks;
    private static final String BASE="https://reading.nyachu.site",PKG="site.nyachu.reading";
    private static void ok(boolean value){checks++;if(!value)throw new AssertionError("Check "+checks);}
    private interface Task {void run() throws Exception;}
    private static void rejects(Task task) throws Exception {try{task.run();throw new AssertionError("Unexpected success");}catch(IOException expected){checks++;}}
    private static UpdatePolicy.Info info(byte[] body) throws Exception{return new UpdatePolicy.Info(BASE,PKG,3,"1.2.0",body.length,BASE+"/download/app.apk?version=3",UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(body)),26,"Test notes");}
    public static void main(String[] args) throws Exception {
        byte[] body="An original binary download fixture".getBytes("UTF-8");UpdatePolicy.Info info=info(body);ByteArrayOutputStream out=new ByteArrayOutputStream();final long[] progress={0};
        UpdatePolicy.copyVerified(new ByteArrayInputStream(body),out,info,new AtomicBoolean(),n->progress[0]=n);ok(java.util.Arrays.equals(body,out.toByteArray()));ok(progress[0]==body.length);
        byte[] bad=body.clone();bad[0]^=1;rejects(()->UpdatePolicy.copyVerified(new ByteArrayInputStream(bad),new ByteArrayOutputStream(),info,new AtomicBoolean(),n->{}));
        rejects(()->UpdatePolicy.copyVerified(new ByteArrayInputStream(java.util.Arrays.copyOf(body,body.length-1)),new ByteArrayOutputStream(),info,new AtomicBoolean(),n->{}));
        rejects(()->UpdatePolicy.copyVerified(new ByteArrayInputStream(java.util.Arrays.copyOf(body,body.length+1)),new ByteArrayOutputStream(),info,new AtomicBoolean(),n->{}));
        AtomicBoolean cancel=new AtomicBoolean(true);rejects(()->UpdatePolicy.copyVerified(new ByteArrayInputStream(body),new ByteArrayOutputStream(),info,cancel,n->{}));
        AtomicBoolean mid=new AtomicBoolean();byte[] large=new byte[32768];UpdatePolicy.Info largeInfo=info(large);rejects(()->UpdatePolicy.copyVerified(new ByteArrayInputStream(large),new ByteArrayOutputStream(),largeInfo,mid,n->mid.set(true)));
        rejects(()->UpdatePolicy.copyVerified(new InputStream(){public int read() throws IOException{throw new IOException("Disconnected");}},out,info,new AtomicBoolean(),n->{}));
        for(String url:new String[]{"http://reading.nyachu.site/download/app.apk?version=3","https://evil.test/download/app.apk?version=3",BASE+"/download/app.apk?version=2",BASE+"/download/app.apk?version=3#x",BASE+"/download/other.apk?version=3","https://user@reading.nyachu.site/download/app.apk?version=3"})rejects(()->new UpdatePolicy.Info(BASE,PKG,3,"1.2.0",body.length,url,info.sha256,26,"notes"));
        rejects(()->new UpdatePolicy.Info(BASE,PKG,3,"1.2.0",UpdatePolicy.MAX_APK_BYTES+1,info.apkUrl,info.sha256,26,"notes"));
        rejects(()->new UpdatePolicy.Info(BASE,PKG,3,"1.2.0",0,info.apkUrl,info.sha256,26,"notes"));
        rejects(()->new UpdatePolicy.Info(BASE,PKG,3,"<bad>",body.length,info.apkUrl,info.sha256,26,"notes"));
        rejects(()->new UpdatePolicy.Info(BASE,PKG,3,"1.2.0",body.length,info.apkUrl,"bad",26,"notes"));
        ok(UpdatePolicy.due(1000,0,6000));ok(!UpdatePolicy.due(10000,9000,6000));ok(UpdatePolicy.due(1000,9000,6000));ok(UpdatePolicy.due(15000,9000,6000));
        ok(UpdatePolicy.checkLink(BASE,BASE+"/native/check-update",true,true));
        ok(!UpdatePolicy.checkLink(BASE,BASE+"/native/check-update",false,true));ok(!UpdatePolicy.checkLink(BASE,BASE+"/native/check-update",true,false));
        for(String url:new String[]{"https://evil.test/native/check-update",BASE+"/native/check-update?install=1",BASE+"/native/check-update#auto"})ok(!UpdatePolicy.checkLink(BASE,url,true,true));
        System.out.println("Native update policy: "+checks+" checks passed");
    }
}
