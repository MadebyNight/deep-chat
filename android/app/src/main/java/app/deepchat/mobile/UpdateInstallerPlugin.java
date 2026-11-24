package app.deepchat.mobile;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

@CapacitorPlugin(name = "UpdateInstaller")
public final class UpdateInstallerPlugin extends Plugin {
    private static final String LEGACY_APK = "app-debug.apk";
    private static final String MANIFEST = "app-update.json";
    private static final long MAX_BYTES = 300L * 1024 * 1024;
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final OkHttpClient network = new OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
            .connectTimeout(8, TimeUnit.SECONDS).readTimeout(18, TimeUnit.SECONDS).build();
    private volatile List<Asset> selected = Collections.emptyList();
    private final AtomicBoolean checking = new AtomicBoolean();
    private static final Object DOWNLOAD_LOCK = new Object();
    private static volatile Transfer active;
    private static volatile Asset verified;
    private static boolean cachePrepared;
    private Transfer ownedTransfer;
    private volatile boolean destroyed;

    enum Source {
        GITHUB("GitHub", "github.com", "/MadebyNight/deep-chat", "https://api.github.com/repos/MadebyNight/deep-chat/releases/latest"),
        GITEE("Gitee", "gitee.com", "/madebynight/Deep-Chat", "https://gitee.com/api/v5/repos/madebynight/Deep-Chat/releases/latest");

        final String label, host, repoPath, endpoint;
        Source(String label, String host, String repoPath, String endpoint) {
            this.label = label;
            this.host = host;
            this.repoPath = repoPath;
            this.endpoint = endpoint;
        }

        boolean isReleaseAsset(HttpUrl url, String tag, String name) {
            return isSecure(url) && host.equals(url.host()) && url.query() == null &&
                    url.encodedPath().equals(repoPath + "/releases/download/" + tag + "/" + name);
        }

        boolean acceptsRedirect(HttpUrl url, String tag, String name) {
            if (!isSecure(url)) return false;
            if (isReleaseAsset(url, tag, name)) return true;
            if (this == GITHUB) {
                return url.host().equals("release-assets.githubusercontent.com") && url.encodedPath().startsWith("/github-production-release-asset/");
            }
            return (url.host().equals(host) && url.encodedPath().matches(repoPath + "/attach_files/[0-9]+/download/" + Pattern.quote(name))) ||
                    (url.host().equals("foruda.gitee.com") && url.encodedPath().matches("/attach_file/[0-9]+/" + Pattern.quote(name)));
        }
    }

    record Asset(Source source, String tag, String version, String name, HttpUrl url, long size, String sha256) {
        Asset(Source source, String tag, String version, HttpUrl url, long size, String sha256) {
            this(source, tag, version, LEGACY_APK, url, size, sha256);
        }
    }
    private record Lookup(Asset asset, String failure, long finishedAt) { }
    private static final class Transfer {
        volatile Call request;
        volatile boolean cancelled;
        void cancel() {
            cancelled = true;
            Call call = request;
            if (call != null) call.cancel();
        }
    }
    private static final class Failure extends IOException {
        final String code;
        Failure(String code) { this.code = code; }
    }

    private static boolean isSecure(HttpUrl url) {
        return url != null && url.isHttps() && url.port() == 443 && url.encodedUsername().isEmpty() &&
                url.encodedPassword().isEmpty() && url.fragment() == null;
    }

    static boolean isVersion(String value) {
        return value.matches("v?(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(\\.(0|[1-9][0-9]{0,8}))?");
    }

    static int compareVersions(String left, String right) {
        String[] a = left.replaceFirst("^v", "").split("\\.");
        String[] b = right.replaceFirst("^v", "").split("\\.");
        for (int i = 0; i < 3; i++) {
            int result = Integer.compare(i < a.length ? Integer.parseInt(a[i]) : 0, i < b.length ? Integer.parseInt(b[i]) : 0);
            if (result != 0) return result;
        }
        return 0;
    }

    private static byte[] readSmall(ResponseBody body, int limit) throws IOException {
        if (body == null || body.contentLength() > limit) throw new Failure("INVALID");
        try (InputStream input = body.byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (output.size() + read > limit) throw new Failure("INVALID");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private JSONObject metadata(Source source) throws IOException, JSONException {
        Call call = network.newCall(new Request.Builder().url(source.endpoint).header("Accept", "application/json").build());
        call.timeout().timeout(8, TimeUnit.SECONDS);
        try (Response response = call.execute()) {
            if (response.code() == 404) return null;
            if (response.code() == 403 || response.code() == 429) throw new Failure("LIMITED");
            if (!response.isSuccessful()) throw new Failure("NETWORK");
            String json = new String(readSmall(response.body(), 512 * 1024), StandardCharsets.UTF_8);
            return json.trim().equals("null") ? null : new JSONObject(json);
        }
    }

    private Lookup lookup(Source source) {
        try {
            return new Lookup(readRelease(source), null, System.nanoTime());
        } catch (Failure failure) {
            return new Lookup(null, failure.code, System.nanoTime());
        } catch (JSONException | IllegalArgumentException failure) {
            return new Lookup(null, "INVALID", System.nanoTime());
        } catch (IOException failure) {
            return new Lookup(null, "NETWORK", System.nanoTime());
        }
    }

    private Asset readRelease(Source source) throws IOException, JSONException {
        JSONObject release = metadata(source);
        if (release == null || release.optBoolean("draft") || release.optBoolean("prerelease")) return null;
        String tag = release.optString("tag_name");
        if (!isVersion(tag)) throw new Failure("INVALID");
        String version = tag.replaceFirst("^v", "");
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) throw new Failure("INVALID");
        JSONObject apk = findApkAsset(assets, version);
        if (apk == null || (source == Source.GITHUB && !"uploaded".equals(apk.optString("state")))) return null;
        String apkName = apk.optString("name");
        HttpUrl url = HttpUrl.parse(apk.optString("browser_download_url"));
        if (!source.isReleaseAsset(url, tag, apkName)) throw new Failure("INVALID");
        long size = apk.optLong("size", -1);
        String digest = apk.optString("digest");
        if (source == Source.GITEE) {
            JSONObject manifest = findAsset(assets, MANIFEST);
            if (manifest == null) return null;
            HttpUrl manifestUrl = HttpUrl.parse(manifest.optString("browser_download_url"));
            try (Response response = openAsset(source, tag, MANIFEST, manifestUrl, null, System.nanoTime() + TimeUnit.SECONDS.toNanos(6))) {
                JSONObject data = new JSONObject(new String(readSmall(response.body(), 4096), StandardCharsets.UTF_8));
                if (!tag.equals(data.optString("tag")) || !apkName.equals(data.optString("file"))) throw new Failure("INVALID");
                long manifestSize = data.optLong("size", -1);
                if (size > 0 && size != manifestSize) throw new Failure("INVALID");
                size = manifestSize;
                digest = "sha256:" + data.optString("sha256");
            }
        }
        if (size <= 0 || size > MAX_BYTES || !digest.matches("sha256:[0-9a-fA-F]{64}")) throw new Failure("INVALID");
        return new Asset(source, tag, version, apkName, url, size, digest.substring(7).toLowerCase(Locale.ROOT));
    }

    private static JSONObject findApkAsset(JSONArray assets, String version) throws Failure {
        for (String candidate : new String[] { "DeepChat-" + version + ".apk", "DeepChat-v" + version + ".apk", LEGACY_APK }) {
            JSONObject found = findAsset(assets, candidate);
            if (found != null) return found;
        }
        return null;
    }

    private static JSONObject findAsset(JSONArray assets, String name) throws Failure {
        JSONObject found = null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject next = assets.optJSONObject(i);
            if (next != null && name.equals(next.optString("name"))) {
                if (found != null) throw new Failure("INVALID");
                found = next;
            }
        }
        return found;
    }

    static List<Asset> chooseAssets(Asset first, Asset second) {
        if (first == null) return second == null ? Collections.emptyList() : Collections.singletonList(second);
        if (second == null) return Collections.singletonList(first);
        int order = compareVersions(first.version, second.version);
        if (order < 0) return Collections.singletonList(second);
        if (order > 0) return Collections.singletonList(first);
        if (first.size != second.size || !first.sha256.equals(second.sha256)) return Collections.emptyList();
        return Arrays.asList(first, second);
    }

    @PluginMethod
    public void check(PluginCall call) {
        if (destroyed || !checking.compareAndSet(false, true)) {
            call.reject("Update check already in progress", "NETWORK");
            return;
        }
        CompletableFuture.supplyAsync(() -> lookup(Source.GITHUB), workers)
                .thenCombine(CompletableFuture.supplyAsync(() -> lookup(Source.GITEE), workers), (github, gitee) -> {
                    Lookup first = github.finishedAt <= gitee.finishedAt ? github : gitee;
                    Lookup second = first == github ? gitee : github;
                    List<Asset> candidates = chooseAssets(first.asset, second.asset);
                    if (candidates.isEmpty()) {
                        selected = Collections.emptyList();
                        if (first.asset != null && second.asset != null) {
                            call.reject("Update sources disagree", "INVALID");
                        } else if (github.failure != null || gitee.failure != null) {
                            call.reject("Cannot check for updates", github.failure != null ? github.failure : gitee.failure);
                        } else {
                            call.resolve(new JSObject());
                        }
                    } else {
                        selected = candidates;
                        Asset asset = candidates.get(0);
                        Asset ready = verified;
                        call.resolve(new JSObject().put("version", asset.version)
                                .put("ready", ready != null && ready.sha256.equals(asset.sha256) && updateFile().isFile()));
                    }
                    return null;
                }).exceptionally(error -> {
                    call.reject("Cannot check for updates", "NETWORK");
                    return null;
                }).whenComplete((result, error) -> checking.set(false));
    }

    private Response openAsset(Source source, String tag, String name, HttpUrl url, Transfer transfer, long deadline) throws IOException {
        if (!source.isReleaseAsset(url, tag, name)) throw new Failure("INVALID");
        for (int hop = 0; hop <= 3; hop++) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new Failure("NETWORK");
            Call request = network.newCall(new Request.Builder().url(url).header("Accept-Encoding", "identity").build());
            request.timeout().timeout(remaining, TimeUnit.NANOSECONDS);
            if (transfer != null) {
                transfer.request = request;
                if (transfer.cancelled || destroyed) throw new Failure("CANCELLED");
            }
            Response response = request.execute();
            int code = response.code();
            if (code == 200) return response;
            HttpUrl next = null;
            try (response) {
                String location = response.header("Location");
                if ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308) && location != null) next = url.resolve(location);
            }
            if (!source.acceptsRedirect(next, tag, name)) throw new Failure("NETWORK");
            url = next;
        }
        throw new Failure("NETWORK");
    }

    private File updateDirectory() { return new File(getContext().getCacheDir(), "verified-updates"); }
    private File updateFile() { return new File(updateDirectory(), "update.apk"); }
    private File partialFile() { return new File(getContext().getCacheDir(), "deepchat-update-partial.apk"); }

    @Override
    public void load() {
        // Clear old files only once per process; a recreated Activity still owns the same cache.
        synchronized (DOWNLOAD_LOCK) {
            if (!cachePrepared) {
                partialFile().delete();
                updateFile().delete();
                cachePrepared = true;
            }
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        List<Asset> candidates = selected;
        Transfer transfer = new Transfer();
        synchronized (DOWNLOAD_LOCK) {
            if (destroyed || active != null || candidates.isEmpty() || !candidates.get(0).version.equals(call.getString("version"))) {
                call.reject("No matching update", "INVALID");
                return;
            }
            active = transfer;
            ownedTransfer = transfer;
            verified = null;
        }
        workers.execute(() -> {
            File partial = partialFile();
            String outcome = "NETWORK";
            try {
                for (Asset asset : candidates) {
                    if (destroyed || transfer.cancelled) break;
                    try {
                        downloadAsset(asset, partial, transfer);
                        verifyApk(partial, asset.version);
                        if (destroyed || transfer.cancelled) break;
                        File directory = updateDirectory();
                        File file = updateFile();
                        if ((!directory.isDirectory() && !directory.mkdirs()) ||
                                (file.exists() && !file.delete()) || !partial.renameTo(file)) throw new Failure("STORAGE");
                        verified = asset;
                        outcome = null;
                        break;
                    } catch (Failure failure) {
                        outcome = failure.code;
                        if (outcome.equals("PACKAGE") || outcome.equals("STORAGE")) break;
                    } catch (IOException failure) {
                        outcome = "NETWORK";
                    } finally {
                        partial.delete();
                    }
                }
            } finally {
                transfer.request = null;
                if (transfer.cancelled || destroyed) {
                    verified = null;
                    updateFile().delete();
                    outcome = "CANCELLED";
                }
                synchronized (DOWNLOAD_LOCK) {
                    active = null;
                    ownedTransfer = null;
                }
                if (outcome == null) call.resolve();
                else call.reject("Could not download update", outcome);
            }
        });
    }

    private void downloadAsset(Asset asset, File partial, Transfer transfer) throws IOException {
        if (getContext().getCacheDir().getUsableSpace() < asset.size) throw new Failure("STORAGE");
        report(asset, 0);
        MessageDigest digest = sha256();
        long bytes = 0;
        long notified = 0;
        try (Response response = openAsset(asset.source, asset.tag, asset.name, asset.url, transfer, System.nanoTime() + TimeUnit.MINUTES.toNanos(20))) {
            ResponseBody body = response.body();
            if (body == null || (body.contentLength() >= 0 && body.contentLength() != asset.size)) throw new Failure("INTEGRITY");
            try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (transfer.cancelled || destroyed) throw new Failure("CANCELLED");
                    bytes += count;
                    if (bytes > asset.size) throw new Failure("INTEGRITY");
                    try { output.write(buffer, 0, count); } catch (IOException failure) { throw new Failure("STORAGE"); }
                    digest.update(buffer, 0, count);
                    if (bytes - notified >= 1024 * 1024) {
                        report(asset, bytes);
                        notified = bytes;
                    }
                }
            }
        }
        if (bytes != asset.size || !hex(digest.digest()).equals(asset.sha256)) throw new Failure("INTEGRITY");
        report(asset, bytes);
    }

    private void report(Asset asset, long bytes) {
        if (!destroyed) notifyListeners("progress", new JSObject().put("source", asset.source.label)
                .put("bytes", bytes).put("total", asset.size));
    }

    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    private static String hex(byte[] digest) {
        StringBuilder out = new StringBuilder(2 * digest.length);
        for (byte b : digest) {
            out.append(Character.forDigit((b & 0xf0) >>> 4, 16));
            out.append(Character.forDigit(b & 15, 16));
        }
        return out.toString();
    }

    @SuppressWarnings("deprecation")
    private void verifyApk(File file, String version) throws Failure {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        try {
            PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flags);
            PackageInfo archive = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
            if (archive == null || !installed.packageName.equals(archive.packageName) ||
                    !version.equals(archive.versionName) || versionCode(archive) <= versionCode(installed)) throw new Failure("PACKAGE");
            String[] expected = signerIds(installed), actual = signerIds(archive);
            if (expected.length == 0 || !Arrays.equals(expected, actual)) throw new Failure("PACKAGE");
        } catch (PackageManager.NameNotFoundException | IllegalArgumentException e) {
            throw new Failure("PACKAGE");
        }
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static String[] signerIds(PackageInfo info) {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
                ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        return signatures == null ? new String[0] : Arrays.stream(signatures)
                .map(signature -> hex(sha256().digest(signature.toByteArray()))).sorted().toArray(String[]::new);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Transfer transfer = active;
        if (transfer != null) transfer.cancel();
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Asset ready = verified;
            File file = updateFile();
            if (ready == null || !ready.version.equals(call.getString("version")) || file.length() != ready.size || active != null) {
                call.reject("No verified update", "MISSING");
                return;
            }
            try {
                Intent intent;
                boolean needsPermission = Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls();
                if (needsPermission) {
                    intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                } else {
                    Uri apk = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".updates", file);
                    intent = new Intent(Intent.ACTION_VIEW).setDataAndType(apk, APK_MIME).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                getActivity().startActivity(intent);
                call.resolve(new JSObject().put("needsPermission", needsPermission));
            } catch (RuntimeException e) {
                call.reject("Cannot open Android installer", "INSTALL");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (DOWNLOAD_LOCK) {
            destroyed = true;
            if (ownedTransfer != null) ownedTransfer.cancel();
        }
        workers.shutdown();
    }
}
