package app.deepchat.mobile;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.HttpUrl;
import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

@RunWith(AndroidJUnit4.class)
public class UpdateInstallerInstrumentedTest {
    private static final class Result extends PluginCall {
        private final CountDownLatch latch = new CountDownLatch(1);
        private JSObject payload;
        private String code;
        Result(String version) { super(null, "UpdateInstaller", "test", "test", new JSObject().put("version", version)); }
        @Override public void resolve(JSObject value) { payload = value; latch.countDown(); }
        @Override public void resolve() { resolve(new JSObject()); }
        @Override public void reject(String message, String error) { code = error; latch.countDown(); }
        Result result() throws InterruptedException {
            assertTrue("Native call timed out", latch.await(12, TimeUnit.SECONDS));
            return this;
        }
    }

    private static Response answer(Request request, int code, byte[] body, String location) {
        Response.Builder result = new Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                .code(code).message("fixture").body(ResponseBody.create(body, (MediaType) null));
        if (location != null) result.header("Location", location);
        return result.build();
    }

    private static byte[] json(String tag, String url, int size, String hash) {
        return ("{\"tag_name\":\"" + tag + "\",\"draft\":false,\"prerelease\":false,\"assets\":["
                + "{\"name\":\"app-debug.apk\",\"state\":\"uploaded\",\"size\":" + size
                + ",\"digest\":\"sha256:" + hash + "\",\"browser_download_url\":\"" + url + "\"}"
                + (url.contains("gitee.com") ? ",{\"name\":\"app-update.json\",\"browser_download_url\":\""
                + url.replace("app-debug.apk", "app-update.json") + "\"}" : "") + "]}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    @Test public void downloadsAndOpensSystemInstaller() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        var context = instrumentation.getTargetContext();
        File fixture = new File(context.getFilesDir(), "test-update.apk");
        org.junit.Assume.assumeTrue("Requires the isolated app and a signed update fixture",
                "app.deepchat.mobile.isolatedtest".equals(context.getPackageName()) && fixture.isFile());
        byte[] apk = java.nio.file.Files.readAllBytes(fixture.toPath());
        StringBuilder digest = new StringBuilder();
        for (byte value : java.security.MessageDigest.getInstance("SHA-256").digest(apk)) digest.append(String.format(java.util.Locale.ROOT, "%02x", value));
        String hash = digest.toString();
        String github = "https://github.com/MadebyNight/deep-chat/releases/download/v1.0.5/app-debug.apk";
        String cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/test-fixture";
        String gitee = "https://gitee.com/madebynight/Deep-Chat/releases/download/v1.0.5/app-debug.apk";
        AtomicReference<String> mode = new AtomicReference<>("github-only");
        CountDownLatch fellBack = new CountDownLatch(1);
        Interceptor fake = chain -> {
            Request request = chain.request();
            String url = request.url().toString();
            assertNull(request.header("Cookie"));
            if (url.equals(UpdateInstallerPlugin.Source.GITHUB.endpoint)) {
                return answer(request, 200, json("v1.0.5", github, apk.length, hash), null);
            }
            if (url.equals(UpdateInstallerPlugin.Source.GITEE.endpoint)) {
                if (!mode.get().equals("mirror")) return answer(request, 404, new byte[0], null);
                try { Thread.sleep(130); } catch (InterruptedException e) { throw new IOException(e); }
                return answer(request, 200, json("v1.0.5", gitee, apk.length, hash), null);
            }
            if (url.equals(gitee.replace("app-debug.apk", "app-update.json"))) {
                String manifest = "{\"tag\":\"v1.0.5\",\"file\":\"app-debug.apk\",\"size\":" + apk.length + ",\"sha256\":\"" + hash + "\"}";
                return answer(request, 200, manifest.getBytes(java.nio.charset.StandardCharsets.UTF_8), null);
            }
            if (url.equals(github)) return answer(request, 302, new byte[0], cdn);
            if (url.equals(cdn)) {
                if (mode.get().equals("mirror")) return answer(request, 502, new byte[0], null);
                byte[] corrupt = apk.clone();
                corrupt[0] ^= 1;
                return answer(request, 200, corrupt, null);
            }
            if (url.equals(gitee)) {
                fellBack.countDown();
                return answer(request, 200, apk, null);
            }
            throw new IOException("unexpected fixture request");
        };
        Intent launch = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(launch);
        UpdateInstallerPlugin plugin = (UpdateInstallerPlugin) activity.getBridge().getPlugin("UpdateInstaller").getInstance();
        Field network = UpdateInstallerPlugin.class.getDeclaredField("network");
        network.setAccessible(true);
        network.set(plugin, new OkHttpClient.Builder().addInterceptor(fake).build());
        Result check = new Result(null);
        plugin.check(check);
        assertEquals("1.0.5", check.result().payload.getString("version"));
        Result download = new Result("1.0.5");
        plugin.download(download);
        assertEquals("INTEGRITY", download.result().code);
        assertFalse(new File(context.getCacheDir(), "verified-updates/update.apk").exists());

        mode.set("mirror");
        check = new Result(null);
        plugin.check(check);
        assertEquals("1.0.5", check.result().payload.getString("version"));
        download = new Result("1.0.5");
        plugin.download(download);
        assertNull(download.result().code);
        assertTrue(fellBack.await(2, TimeUnit.SECONDS));
        assertTrue(new File(context.getCacheDir(), "verified-updates/update.apk").isFile());

        boolean permitted = context.getPackageManager().canRequestPackageInstalls();
        Result install = new Result("1.0.5");
        plugin.install(install);
        assertNull(install.result().code);
        assertEquals(!permitted, install.payload.optBoolean("needsPermission"));
    }

    @Test public void selectsOnlyMatchingMirrors() {
        var gh = UpdateInstallerPlugin.Source.GITHUB;
        var ge = UpdateInstallerPlugin.Source.GITEE;
        var a = new UpdateInstallerPlugin.Asset(gh, "v1.0.5", "1.0.5", (HttpUrl) null, 1024, "same");
        var b = new UpdateInstallerPlugin.Asset(ge, "v1.0.5", "1.0.5", (HttpUrl) null, 1024, "same");
        var old = new UpdateInstallerPlugin.Asset(ge, "v1.0.4", "1.0.4", (HttpUrl) null, 1024, "same");
        var mismatch = new UpdateInstallerPlugin.Asset(ge, "v1.0.5", "1.0.5", (HttpUrl) null, 1024, "different");
        assertEquals(java.util.Arrays.asList(b, a), UpdateInstallerPlugin.chooseAssets(b, a));
        assertEquals(java.util.Collections.singletonList(a), UpdateInstallerPlugin.chooseAssets(old, a));
        assertEquals(java.util.Collections.singletonList(a), UpdateInstallerPlugin.chooseAssets(a, null));
        assertTrue(UpdateInstallerPlugin.chooseAssets(a, mismatch).isEmpty());
        assertFalse(gh.acceptsRedirect(HttpUrl.get("https://github.com.invalid/app-debug.apk"), "v1.0.5", "app-debug.apk"));
    }
}
