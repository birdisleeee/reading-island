package site.nyachu.reading;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.JsPromptResult;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import org.json.JSONObject;

/** Online client: account approval and all reading data belong to the independent public backend. */
public final class MainActivity extends Activity {
    // Replace with your own public deployment when building a self-hosted variant. No credentials belong here.
    private static final String BASE_URL = "https://reading.nyachu.site";
    private static final int PICK_IMAGE = 401;
    private WebView web;
    private ProgressBar progress;
    private LinearLayout errorPanel;
    private TextView errorText;
    private ValueCallback<Uri[]> chooser;
    private String lastUrl = BASE_URL + "/app";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(239,236,243)); root.setFitsSystemWindows(true);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v,insets)->{
                android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());
                v.setPadding(bars.left,bars.top,bars.right,bars.bottom); return insets;
            });
        }
        LinearLayout toolbar=new LinearLayout(this); toolbar.setGravity(Gravity.CENTER_VERTICAL);
        TextView title=new TextView(this); title.setText("共读岛"); title.setTextSize(17);title.setTextColor(Color.rgb(41,37,47));title.setPadding(dp(16),0,0,0);
        toolbar.addView(title,new LinearLayout.LayoutParams(0,dp(48),1));
        addButton(toolbar,"账户",()->web.loadUrl(BASE_URL+"/app"));
        addButton(toolbar,"分享",this::share);
        addButton(toolbar,"刷新",()->web.reload());root.addView(toolbar);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);root.addView(progress,new LinearLayout.LayoutParams(-1,dp(3)));
        errorPanel=new LinearLayout(this);errorPanel.setOrientation(LinearLayout.VERTICAL);errorPanel.setPadding(dp(22),dp(24),dp(22),dp(24));
        errorText=new TextView(this);errorText.setTextSize(16);errorPanel.addView(errorText);addButton(errorPanel,"重试",()->web.loadUrl(lastUrl));errorPanel.setVisibility(View.GONE);root.addView(errorPanel);
        web=new WebView(this);root.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(true);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setSupportMultipleWindows(false);settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSafeBrowsingEnabled(true);CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return navigate(r.getUrl());}
            @Override public void onPageStarted(WebView v,String url,android.graphics.Bitmap icon){if(trusted(Uri.parse(url))){lastUrl=url;errorPanel.setVisibility(View.GONE);web.setVisibility(View.VISIBLE);}progress.setVisibility(View.VISIBLE);}
            @Override public void onPageFinished(WebView v,String url){CookieManager.getInstance().flush();progress.setVisibility(View.GONE);}
            @Override public void onReceivedSslError(WebView v,SslErrorHandler h,SslError e){h.cancel();showError("无法验证服务连接，请检查网络、系统时间或稍后重试。");}
            @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){if(r.isForMainFrame())showError("暂时无法连接共读服务。请联网后重试，书籍和讨论保存在你的公共服务账号中。");}
            @Override public void onReceivedHttpError(WebView v,WebResourceRequest r,WebResourceResponse response){if(r.isForMainFrame()&&response.getStatusCode()>=500)showError("服务暂时不可用，请稍后重试。");}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onProgressChanged(WebView v,int value){progress.setProgress(value);}
            @Override public boolean onJsAlert(WebView v,String url,String msg,JsResult result){if(!trusted(Uri.parse(url)))return false;new AlertDialog.Builder(MainActivity.this).setMessage(msg).setPositiveButton("确定",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show();return true;}
            @Override public boolean onJsConfirm(WebView v,String url,String msg,JsResult result){if(!trusted(Uri.parse(url)))return false;new AlertDialog.Builder(MainActivity.this).setMessage(msg).setPositiveButton("确认",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;}
            @Override public boolean onJsPrompt(WebView v,String url,String message,String value,JsPromptResult result){if(!trusted(Uri.parse(url)))return false;EditText input=new EditText(MainActivity.this);input.setText(value);new AlertDialog.Builder(MainActivity.this).setMessage(message).setView(input).setPositiveButton("确认",(d,w)->result.confirm(input.getText().toString())).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;}
            @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> callback,FileChooserParams params){if(!trusted(Uri.parse(v.getUrl()==null?"":v.getUrl()))){callback.onReceiveValue(null);return true;}if(chooser!=null)chooser.onReceiveValue(null);chooser=callback;Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT);pick.addCategory(Intent.CATEGORY_OPENABLE);String[] accepted=params.getAcceptTypes();pick.setType("*/*");if(accepted!=null&&accepted.length>0&&!accepted[0].isEmpty()){java.util.ArrayList<String> mime=new java.util.ArrayList<>();for(String type:accepted)if(type.contains("/"))mime.add(type);if(!mime.isEmpty())pick.putExtra(Intent.EXTRA_MIME_TYPES,mime.toArray(new String[0]));}pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);try{startActivityForResult(pick,PICK_IMAGE);}catch(Exception e){chooser.onReceiveValue(null);chooser=null;showMessage("手机没有可用的图片选择器");}return true;}
        });
        web.setDownloadListener((url,userAgent,disposition,mime,size)->download(url,userAgent,disposition,mime));
        // Do not restore login pages/forms or management URLs from Android backups or saved state.
        web.loadUrl(BASE_URL+"/app");
    }
    private void download(String url,String userAgent,String disposition,String mime){
        if(!trusted(Uri.parse(url)))return;
        try{
            String filename=android.webkit.URLUtil.guessFileName(url,disposition,mime).replace('/','_').replace('\\','_');
            if(filename.length()>120)filename=filename.substring(filename.length()-120);
            android.app.DownloadManager.Request request=new android.app.DownloadManager.Request(Uri.parse(url));
            String cookie=CookieManager.getInstance().getCookie(url);if(cookie!=null)request.addRequestHeader("Cookie",cookie);
            request.addRequestHeader("User-Agent",userAgent);request.setMimeType(mime);request.setTitle(filename);
            request.setDestinationInExternalFilesDir(this,android.os.Environment.DIRECTORY_DOWNLOADS,filename);
            request.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            ((android.app.DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            showMessage("已开始下载，可在系统下载记录中查看。");
        }catch(Exception e){showMessage("暂时无法下载，请稍后重试。");}
    }
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private void addButton(LinearLayout parent,String text,Runnable action){Button b=new Button(this);b.setText(text);b.setTextSize(13);b.setAllCaps(false);b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(dp(10),0,dp(10),0);b.setOnClickListener(v->action.run());parent.addView(b,new LinearLayout.LayoutParams(-2,dp(48)));}
    private boolean trusted(Uri uri){Uri base=Uri.parse(BASE_URL);return "https".equals(uri.getScheme())&&base.getHost().equalsIgnoreCase(uri.getHost()==null?"":uri.getHost())&&(uri.getPort()==-1||uri.getPort()==443)&&uri.getUserInfo()==null;}
    private boolean navigate(Uri uri){if(trusted(uri))return false;String scheme=uri.getScheme();if("https".equals(scheme)||"tel".equals(scheme)||"mailto".equals(scheme)){openExternal(uri);return true;}showMessage("此链接无法在共读应用中打开");return true;}
    private void openExternal(Uri uri){try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception e){showMessage("没有可打开此链接的应用");}}
    private void showMessage(String text){new AlertDialog.Builder(this).setMessage(text).setPositiveButton("知道了",null).show();}
    private void showError(String text){errorText.setText(text);errorPanel.setVisibility(View.VISIBLE);web.setVisibility(View.GONE);progress.setVisibility(View.GONE);}
    private void share(){String url=web.getUrl();if(url==null||!trusted(Uri.parse(url)))return;String shared=BASE_URL+"/app";Intent intent=new Intent(Intent.ACTION_SEND);intent.setType("text/plain");intent.putExtra(Intent.EXTRA_TEXT,"共读岛："+shared);startActivity(Intent.createChooser(intent,"分享共读岛"));}
    @Override protected void onActivityResult(int req,int result,Intent data){super.onActivityResult(req,result,data);if(req!=PICK_IMAGE||chooser==null)return;Uri uri=result==RESULT_OK&&data!=null?data.getData():null;boolean ok=uri!=null&&"content".equals(uri.getScheme());chooser.onReceiveValue(ok?new Uri[]{uri}:null);chooser=null;if(uri!=null&&!ok)showMessage("请选择可读取的文件");}
    @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else new AlertDialog.Builder(this).setMessage("退出共读岛？").setPositiveButton("退出",(d,w)->finish()).setNegativeButton("继续使用",null).show();}
    @Override protected void onPause(){super.onPause();web.onPause();web.pauseTimers();CookieManager.getInstance().flush();}
    @Override protected void onResume(){super.onResume();if(web!=null){web.onResume();web.resumeTimers();}}
    @Override protected void onDestroy(){if(chooser!=null)chooser.onReceiveValue(null);if(web!=null){web.stopLoading();web.destroy();}super.onDestroy();}
}
