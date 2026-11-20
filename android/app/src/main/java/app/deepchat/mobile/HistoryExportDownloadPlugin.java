package app.deepchat.mobile;

import android.net.Uri;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URI;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

@CapacitorPlugin(name = "HistoryExportDownload")
public final class HistoryExportDownloadPlugin extends Plugin {
    private static final long MAX_BYTES = 256L * 1024 * 1024;
    private static final long TIME_LIMIT = 5 * 60_000;
    private static final String OFFICIAL_EXPORT_HOST =
            "deepseek-chat-history-exports-prod.obs.cn-east-3.myhuaweicloud.com";
    private final OkHttpClient http = new OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES)
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, Download> active = new ConcurrentHashMap<>();

    private static final class Download {
        volatile boolean cancelled;
        volatile Call request;

        void cancel() {
            cancelled = true;
            Call current = request;
            if (current != null) current.cancel();
        }

        void check(long deadline) throws DownloadFailure {
            if (cancelled) throw new DownloadFailure("CANCELLED");
            if (SystemClock.elapsedRealtime() >= deadline) throw new DownloadFailure("NETWORK");
        }
    }

    private static final class DownloadFailure extends IOException {
        final String code;
        final String host;
        DownloadFailure(String code) { this(code, null); }
        DownloadFailure(String code, String host) {
            this.code = code;
            this.host = host;
        }
    }

    private File cacheDirectory() {
        return new File(getContext().getCacheDir(), "history-downloads");
    }

    @Override
    public void load() {
        File[] files = cacheDirectory().listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - 24 * 60 * 60_000L;
        for (File file : files) {
            if (file.lastModified() < cutoff) file.delete();
        }
    }

    @Override
    protected void handleOnDestroy() {
        active.values().forEach(Download::cancel);
        executor.shutdown();
    }

    private static boolean validId(String id) {
        return id.matches("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}");
    }

    private static URI validate(URI url, String failureCode) throws DownloadFailure {
        String host = url.getHost();
        if (host != null) host = host.toLowerCase(Locale.ROOT);
        if ("https".equalsIgnoreCase(url.getScheme()) && host != null &&
                (host.equals(OFFICIAL_EXPORT_HOST) || host.equals("deepseek.com") || host.endsWith(".deepseek.com")) &&
                url.getRawUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443)) {
            return url;
        }
        throw new DownloadFailure(failureCode, host);
    }

    private static URI resolveLink(URI base, String input, String failureCode) throws DownloadFailure {
        try {
            URI target = URI.create(input);
            return validate(base == null ? target : base.resolve(target), failureCode);
        } catch (IllegalArgumentException ignored) {
            throw new DownloadFailure(failureCode);
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String id = call.getString("id", "");
        if (!validId(id)) {
            call.reject("Invalid download ID", "LINK");
            return;
        }
        Download operation = new Download();
        if (active.putIfAbsent(id, operation) != null) {
            call.reject("Duplicate download", "NETWORK");
            return;
        }
        File directory = cacheDirectory();
        File destination = new File(directory, id + ".zip");
        executor.execute(() -> {
            boolean success = false;
            try {
                URI url = resolveLink(null, call.getString("url", ""), "LINK_INPUT");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException();
                long size = downloadZip(url, destination, operation);
                call.resolve(new JSObject().put("size", size).put("uri", Uri.fromFile(destination).toString()));
                success = true;
            } catch (DownloadFailure error) {
                JSObject details = new JSObject();
                if (error.host != null) details.put("host", error.host);
                call.reject("Could not download history ZIP", error.code, details);
            } catch (IOException | IllegalArgumentException error) {
                call.reject("Could not download history ZIP", "NETWORK");
            } finally {
                if (!success || operation.cancelled) destination.delete();
                active.remove(id, operation);
            }
        });
    }

    private long downloadZip(URI url, File destination, Download operation) throws IOException {
        long deadline = SystemClock.elapsedRealtime() + TIME_LIMIT;
        for (int hop = 0; hop <= 5; hop++) {
            operation.check(deadline);
            Request request = new Request.Builder().url(url.toASCIIString())
                    .header("Accept-Encoding", "identity").build();
            Call call = http.newCall(request);
            call.timeout().timeout(Math.max(1, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS);
            operation.request = call;
            operation.check(deadline);
            try (Response response = call.execute()) {
                int status = response.code();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = response.header("Location");
                    if (location == null || hop == 5) throw new DownloadFailure("LINK_REDIRECT");
                    url = resolveLink(url, location, "LINK_REDIRECT");
                    continue;
                }
                if (status == 401 || status == 403 || status == 404 || status == 410) {
                    throw new DownloadFailure("EXPIRED");
                }
                if (status != 200) throw new DownloadFailure("NETWORK");
                ResponseBody body = response.body();
                if (body == null) throw new DownloadFailure("NOT_ZIP");
                return saveZip(body, destination, operation, deadline);
            } finally {
                operation.request = null;
            }
        }
        throw new DownloadFailure("LINK");
    }

    private long saveZip(ResponseBody body, File destination, Download operation, long deadline) throws IOException {
        long expected = body.contentLength();
        if (expected > MAX_BYTES) throw new DownloadFailure("TOO_LARGE");
        try (BufferedInputStream input = new BufferedInputStream(body.byteStream())) {
            int a = input.read(), b = input.read(), c = input.read(), d = input.read();
            if (a != 'P' || b != 'K' || !((c == 3 && d == 4) || (c == 5 && d == 6))) {
                throw new DownloadFailure("NOT_ZIP");
            }
            try (FileOutputStream output = new FileOutputStream(destination)) {
                output.write(new byte[]{(byte) a, (byte) b, (byte) c, (byte) d});
                long size = 4;
                byte[] bytes = new byte[65536];
                int count;
                while ((count = input.read(bytes)) != -1) {
                    operation.check(deadline);
                    size += count;
                    if (size > MAX_BYTES) throw new DownloadFailure("TOO_LARGE");
                    output.write(bytes, 0, count);
                }
                operation.check(deadline);
                if (expected >= 0 && size != expected) throw new IOException();
                return size;
            }
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Download operation = active.get(call.getString("id", ""));
        if (operation != null) operation.cancel();
        call.resolve();
    }

    @PluginMethod
    public void release(PluginCall call) {
        String id = call.getString("id", "");
        if (validId(id)) new File(cacheDirectory(), id + ".zip").delete();
        call.resolve();
    }
}
