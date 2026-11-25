package io.github.valeratim777.pdfreader;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.view.WindowManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Files coming from and going to other apps.
 *
 * - "Open with" and "Share" from WhatsApp, Telegram, mail, file managers: the file is
 *   copied into the app's cache right away (while the app still has the right to read
 *   it) and handed to the page once. The page loads it from the cache.
 * - Opening a PDF with the system picker, so that "Save" can write back into it.
 * - Writing back into the opened file, "Save as" with the system picker, printing,
 *   keeping the screen on while reading.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {

    private static final String HANDLED = "io.github.valeratim777.pdfreader.HANDLED";
    private static final String INCOMING = "incoming";

    private final List<JSObject> pending = new ArrayList<>();
    private int counter = 0;

    @Override
    public void load() {
        super.load();
        // Copies left over from earlier runs; their documents live in the page's own storage now.
        File dir = new File(getContext().getCacheDir(), INCOMING);
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
    }

    // ---------------- files from other apps ----------------

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || intent.getBooleanExtra(HANDLED, false)) return;
        String action = intent.getAction();
        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
            else if (intent.getClipData() != null && intent.getClipData().getItemCount() > 0) uris.add(intent.getClipData().getItemAt(0).getUri());
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        uris.removeIf((u) -> u == null);
        if (uris.isEmpty()) return;
        // The same intent comes again when the activity is recreated; open it only once.
        intent.putExtra(HANDLED, true);
        final boolean view = Intent.ACTION_VIEW.equals(action);
        final boolean writeGranted = (intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
        final String type = intent.getType();
        new Thread(() -> {
            JSArray files = new JSArray();
            JSObject failed = null;
            for (Uri u : uris) {
                try {
                    JSObject f = copyIn(u, type);
                    // Only a file opened for viewing can be saved back, and only if the sender allowed writing.
                    f.put("writable", view && uris.size() == 1 && (writeGranted || canWrite(u)));
                    files.put(f);
                } catch (Exception e) {
                    failed = new JSObject();
                    failed.put("error", String.valueOf(e.getMessage()));
                }
            }
            JSObject batch = new JSObject();
            batch.put("files", files);
            batch.put("source", view ? "view" : "share");
            if (failed != null) batch.put("error", failed.getString("error"));
            synchronized (pending) {
                pending.add(batch);
            }
            notifyListeners("filesReceived", new JSObject(), true);
        }).start();
    }

    /** Files that arrived from other apps since the last call (each batch is handed out once). */
    @PluginMethod
    public void takePending(PluginCall call) {
        JSArray batches = new JSArray();
        synchronized (pending) {
            for (JSObject b : pending) batches.put(b);
            pending.clear();
        }
        JSObject ret = new JSObject();
        ret.put("batches", batches);
        call.resolve(ret);
    }

    // ---------------- opening with the system picker ----------------

    @PluginMethod
    public void pickPdf(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "pickResult");
        } catch (Exception e) {
            call.reject("unavailable", "UNAVAILABLE");
        }
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        final Uri uri = data.getData();
        final int flags = data.getFlags();
        new Thread(() -> {
            try {
                boolean writable = keep(uri, flags);
                JSObject f = copyIn(uri, "application/pdf");
                f.put("writable", writable || canWrite(uri));
                JSObject ret = new JSObject();
                ret.put("file", f);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    // ---------------- saving ----------------

    /** Writes the file at `path` over the document at `uri` (the one that was opened). */
    @PluginMethod
    public void writeBack(PluginCall call) {
        String uri = call.getString("uri");
        String path = call.getString("path");
        if (uri == null || path == null) {
            call.reject("uri and path are required");
            return;
        }
        try {
            copyOut(localFile(path), Uri.parse(uri));
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** "Save as": the system asks where to save; the file at `path` is written there. */
    @PluginMethod
    public void saveAs(PluginCall call) {
        String path = call.getString("path");
        String name = call.getString("name", "document.pdf");
        String mime = call.getString("mime", "application/pdf");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(call, intent, "saveAsResult");
        } catch (Exception e) {
            call.reject("unavailable", "UNAVAILABLE");
        }
    }

    @ActivityCallback
    private void saveAsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        final Uri uri = data.getData();
        final int flags = data.getFlags();
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                copyOut(localFile(path), uri);
                keep(uri, flags);
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                ret.put("name", displayName(uri, call.getString("name", "document.pdf")));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    // ---------------- printing ----------------

    @PluginMethod
    public void print(PluginCall call) {
        final String path = call.getString("path");
        final String name = call.getString("name", "document.pdf");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        final File file;
        try {
            file = localFile(path);
        } catch (IOException e) {
            call.reject(String.valueOf(e.getMessage()));
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                pm.print(name, new PdfPrintAdapter(file, name), new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private static class PdfPrintAdapter extends PrintDocumentAdapter {

        private final File file;
        private final String name;

        PdfPrintAdapter(File file, String name) {
            this.file = file;
            this.name = name;
        }

        @Override
        public void onLayout(
            PrintAttributes oldAttributes,
            PrintAttributes newAttributes,
            CancellationSignal cancellationSignal,
            LayoutResultCallback callback,
            Bundle extras
        ) {
            if (cancellationSignal.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(name)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                .build();
            callback.onLayoutFinished(info, !newAttributes.equals(oldAttributes));
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellationSignal, WriteResultCallback callback) {
            try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
                pipe(in, out);
                callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
            } catch (Exception e) {
                callback.onWriteFailed(String.valueOf(e.getMessage()));
            }
        }
    }

    // ---------------- screen ----------------

    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    // ---------------- helpers ----------------

    /** Copies a document into cache/incoming and describes it for the page. */
    private JSObject copyIn(Uri uri, String fallbackType) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        String type = null;
        try {
            type = cr.getType(uri);
        } catch (Exception ignored) {}
        if (type == null || type.isEmpty() || "application/octet-stream".equals(type)) type = fallbackType;
        String name = displayName(uri, null);
        if (name == null || name.trim().isEmpty()) name = "document";
        name = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (name.length() > 120) name = name.substring(0, 120);
        if ("application/pdf".equals(type) && !name.toLowerCase().endsWith(".pdf")) name += ".pdf";
        File dir = new File(getContext().getCacheDir(), INCOMING);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("cache unavailable");
        // A plain file name in the cache (the real name travels separately), so the page can load it by address.
        int dot = name.lastIndexOf('.');
        String ext = dot > 0 && name.length() - dot <= 6 ? name.substring(dot).replaceAll("[^A-Za-z0-9.]", "") : "";
        File out;
        synchronized (this) {
            out = new File(dir, (counter++) + "-" + System.currentTimeMillis() + ext);
        }
        long size;
        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new IOException("cannot read " + uri);
            size = pipe(in, os);
        }
        JSObject f = new JSObject();
        f.put("path", Uri.fromFile(out).toString());
        f.put("name", name);
        f.put("mime", type == null ? "" : type);
        f.put("size", size);
        f.put("uri", uri.toString());
        return f;
    }

    private void copyOut(File from, Uri to) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        OutputStream os;
        try {
            // "wt" truncates; some providers only know "w".
            os = cr.openOutputStream(to, "wt");
        } catch (Exception e) {
            os = cr.openOutputStream(to, "w");
        }
        if (os == null) throw new IOException("cannot write " + to);
        try (InputStream in = new FileInputStream(from); OutputStream out = os) {
            pipe(in, out);
        }
    }

    /** Keeps access to a document picked with the system picker. Returns true if it may be written. */
    private boolean keep(Uri uri, int flags) {
        boolean write = (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
        int take = Intent.FLAG_GRANT_READ_URI_PERMISSION | (write ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, take);
        } catch (Exception ignored) {}
        return write;
    }

    private boolean canWrite(Uri uri) {
        if (!"content".equals(uri.getScheme())) return false;
        int r = getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        return r == PackageManager.PERMISSION_GRANTED;
    }

    private String displayName(Uri uri, String fallback) {
        if ("file".equals(uri.getScheme())) {
            String n = uri.getLastPathSegment();
            return n != null ? n : fallback;
        }
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {}
        String last = uri.getLastPathSegment();
        if (last != null && last.toLowerCase().endsWith(".pdf")) return last.replaceAll("^.*[:/]", "");
        return fallback;
    }

    /** A file:// address (or a plain path) inside the app's own storage. */
    private File localFile(String path) throws IOException {
        Uri u = Uri.parse(path);
        File f = new File("file".equals(u.getScheme()) ? u.getPath() : path);
        String canonical = f.getCanonicalPath();
        Context ctx = getContext();
        boolean inside =
            canonical.startsWith(ctx.getCacheDir().getCanonicalPath()) ||
            canonical.startsWith(ctx.getFilesDir().getCanonicalPath()) ||
            (ctx.getExternalCacheDir() != null && canonical.startsWith(ctx.getExternalCacheDir().getCanonicalPath()));
        if (!inside) throw new IOException("path not allowed");
        if (!f.exists()) throw new IOException("file not found");
        return f;
    }

    private static long pipe(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            total += n;
        }
        out.flush();
        return total;
    }
}
