package site.nyachu.reading;

import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;

/** Only an explicitly granted, read-only, verified APK URI can leave the app. */
public final class UpdateFileProvider extends ContentProvider {
    @Override public boolean onCreate(){return true;}
    private File file(Uri uri) throws FileNotFoundException {
        if(!"content".equals(uri.getScheme())||!(getContext().getPackageName()+".updates").equals(uri.getAuthority())||uri.getQuery()!=null||uri.getFragment()!=null||uri.getPath()==null||!uri.getPath().matches("/apk/[a-f0-9]{64}\\.apk"))throw new FileNotFoundException("Unknown update");
        File file=new File(new File(getContext().getCacheDir(),"updates"),uri.getLastPathSegment());
        if(!file.isFile())throw new FileNotFoundException("Update expired");return file;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {if(!"r".equals(mode))throw new FileNotFoundException("Read only");return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.MODE_READ_ONLY);}
    @Override public String getType(Uri uri){try{file(uri);return "application/vnd.android.package-archive";}catch(FileNotFoundException e){return null;}}
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){try{File f=file(uri);String[] columns=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection;MatrixCursor c=new MatrixCursor(columns);Object[] row=new Object[columns.length];for(int i=0;i<columns.length;i++)row[i]=OpenableColumns.DISPLAY_NAME.equals(columns[i])?"reading-island.apk":OpenableColumns.SIZE.equals(columns[i])?f.length():null;c.addRow(row);return c;}catch(FileNotFoundException e){return null;}}
    @Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException("Read only");}
    @Override public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException("Read only");}
    @Override public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException("Read only");}
}
