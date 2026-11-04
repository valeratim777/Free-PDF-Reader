package io.github.valeratim777.pdfreader;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Updates the app from inside: downloads the new .apk from the project's releases,
 * checks it against the checksum GitHub publishes and opens the system installer,
 * which installs it over the current app (same package, same signing key).
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private static final String RELEASES = "https://github.com/valeratim777/Free-PDF-Reader/releases/download/";

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        String sha256 = call.getString("sha256", "");
        if (url == null || !url.startsWith(RELEASES) || !url.endsWith(".apk")) {
            call.reject("Address not allowed");
            return;
        }
        new Thread(() -> {
            try {
                File file = new File(getContext().getCacheDir(), "update.apk");
                download(url, file, sha256 == null ? "" : sha256);
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(intent);
                        call.resolve();
                    } catch (Exception e) {
                        call.reject(String.valueOf(e.getMessage()), e);
                    }
                });
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), e);
            }
        }).start();
    }

    private void download(String address, File file, String sha256) throws Exception {
        URL url = new URL(address);
        HttpURLConnection conn = null;
        // GitHub answers with a redirect to its file storage.
        for (int hop = 0; hop < 6; hop++) {
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                conn = null;
                if (location == null) throw new IOException("HTTP " + code);
                url = new URL(url, location);
                if (!"https".equals(url.getProtocol())) throw new IOException("insecure address");
                continue;
            }
            if (code != 200) {
                conn.disconnect();
                throw new IOException("HTTP " + code);
            }
            break;
        }
        if (conn == null) throw new IOException("too many redirects");
        long total = conn.getContentLengthLong();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(file)) {
            byte[] buf = new byte[64 * 1024];
            long got = 0;
            long sent = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                digest.update(buf, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (now - sent > 150) {
                    sent = now;
                    JSObject progress = new JSObject();
                    progress.put("loaded", got);
                    progress.put("total", total);
                    notifyListeners("progress", progress);
                }
            }
        } finally {
            conn.disconnect();
        }
        if (!sha256.isEmpty()) {
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format("%02x", b));
            if (!hex.toString().equalsIgnoreCase(sha256)) {
                file.delete();
                throw new IOException("the download is damaged");
            }
        }
    }
}
