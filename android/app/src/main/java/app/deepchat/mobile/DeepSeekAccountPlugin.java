package app.deepchat.mobile;

import android.content.Context;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.system.Os;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipFile;

import io.github.jackwener.dsh.engine.NodeRuntime;

@CapacitorPlugin(name = "DeepSeekAccount")
public final class DeepSeekAccountPlugin extends Plugin {
    private static final String ASSETS = "deepseek-runtime/";
    private static final RuntimeHost HOST = new RuntimeHost();
    private volatile boolean destroyed;

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        HOST.detach(this);
    }

    private void deliver(Runnable callback) {
        if (destroyed) return;
        getActivity().runOnUiThread(() -> {
            if (!destroyed) callback.run();
        });
    }

    @PluginMethod
    public void availability(PluginCall call) {
        boolean supported = Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a");
        if (supported) {
            try (InputStream asset = getContext().getAssets().open(ASSETS + "harness.zip")) {
                supported = true;
            } catch (IOException missing) {
                supported = false;
            }
        }
        call.resolve(new JSObject().put("supported", supported));
    }

    @PluginMethod
    public void request(PluginCall call) {
        String id = call.getString("id", "");
        String method = call.getString("method", "");
        if (!id.matches("[a-zA-Z0-9-]{1,64}") || !Arrays.asList("state", "signIn",
                "cancelSignIn", "signOut", "balance", "profile", "cancelChat", "transcribe",
                "upload", "messages", "synthesize").contains(method)) {
            call.reject("Invalid account operation");
            return;
        }
        HOST.send(getContext().getApplicationContext(), this, call, id, method);
    }

    private static final class RuntimeHost {
        private final ExecutorService commands = Executors.newSingleThreadExecutor();
        private final ScheduledThreadPoolExecutor timeouts = new ScheduledThreadPoolExecutor(1);
        private final Map<String, Pending> pending = new ConcurrentHashMap<>();
        private volatile OutputStream input;
        private volatile boolean nodeStarted;

        RuntimeHost() {
            timeouts.setRemoveOnCancelPolicy(true);
        }

        private static final class Pending {
            final DeepSeekAccountPlugin plugin;
            final PluginCall call;
            final String method;
            volatile ScheduledFuture<?> deadline;

            Pending(DeepSeekAccountPlugin plugin, PluginCall call, String method) {
                this.plugin = plugin;
                this.call = call;
                this.method = method;
            }
        }

        private boolean remove(String id, Pending request) {
            if (!pending.remove(id, request)) return false;
            ScheduledFuture<?> deadline = request.deadline;
            if (deadline != null) deadline.cancel(false);
            return true;
        }

        void detach(DeepSeekAccountPlugin plugin) {
            pending.forEach((id, request) -> {
                if (request.plugin == plugin && remove(id, request) && isCancellable(request.method)) {
                    commands.execute(() -> cancelRequest(id));
                }
            });
        }

        private static boolean isCancellable(String method) {
            return switch (method) {
                case "messages", "transcribe", "upload", "synthesize" -> true;
                default -> false;
            };
        }

        private void cancelRequest(String id) {
            try {
                write(new JSONObject().put("method", "cancelChat")
                        .put("params", new JSONObject().put("id", id)));
            } catch (Exception ignored) {
                // The runtime may already have stopped.
            }
        }

        void send(Context context, DeepSeekAccountPlugin plugin, PluginCall call, String id, String method) {
            if (plugin.destroyed) return;
            Pending request = new Pending(plugin, call, method);
            if (pending.putIfAbsent(id, request) != null) {
                plugin.deliver(() -> call.reject("Duplicate account operation"));
                return;
            }
            request.deadline = timeouts.schedule(() -> {
                if (remove(id, request)) {
                    plugin.deliver(() -> call.reject("Account operation timed out", "ACCOUNT_TIMEOUT"));
                    if (isCancellable(method)) cancelRequest(id);
                }
            }, method.equals("messages") || method.equals("synthesize") ? 10 : 2, TimeUnit.MINUTES);
            if (plugin.destroyed) remove(id, request);
            if (pending.get(id) != request) {
                request.deadline.cancel(false);
                return;
            }
            commands.execute(() -> {
                if (pending.get(id) != request) return;
                try {
                    start(context);
                    if (pending.get(id) == request) {
                        write(new JSONObject().put("id", id).put("method", method)
                                .put("params", call.getObject("params", new JSObject())));
                    }
                } catch (Exception | LinkageError failure) {
                    if (remove(id, request)) {
                        plugin.deliver(() -> call.reject("Cannot start the DeepSeek account runtime", "ACCOUNT_RUNTIME"));
                    }
                }
            });
        }

        private synchronized void write(JSONObject frame) throws IOException {
            OutputStream stream = input;
            if (stream == null) throw new IOException("Account runtime stopped");
            stream.write((frame + "\n").getBytes(StandardCharsets.UTF_8));
            stream.flush();
        }

        private synchronized void start(Context context) throws Exception {
            if (input != null) return;
            if (nodeStarted) throw new IOException("Restart Deep Chat to recover the account runtime");
            File home = new File(context.getNoBackupFilesDir(), "deepseek-account");
            Files.createDirectories(home.toPath());
            File runtime = new File(context.getNoBackupFilesDir(), "deepseek-runtime");
            File revision = new File(runtime, ".version");
            String version;
            try (ZipFile apk = new ZipFile(context.getPackageCodePath())) {
                ZipEntry archive = apk.getEntry("assets/" + ASSETS + "harness.zip");
                if (archive == null) throw new IOException("Missing account runtime asset");
                version = archive.getSize() + ":" + archive.getCrc();
            }
            String installed = revision.isFile()
                    ? new String(Files.readAllBytes(revision.toPath()), StandardCharsets.UTF_8) : "";
            if (!version.equals(installed)) {
                deleteTree(runtime);
                Files.createDirectories(runtime.toPath());
                extract(context, runtime);
                writeText(revision, version);
            }
            File profile = new File(home, "profiles/deepchat");
            Files.createDirectories(profile.toPath());
            writeText(new File(profile, "package.json"),
                    "{\"name\":\"dsh-profile-deepchat\",\"private\":true}");
            writeText(new File(profile, "cordis.yml"), "[]\n");
            copyAsset(context, "cordis.patch.yml", new File(profile, "cordis.patch.yml"));
            File bridge = new File(profile, "node_modules/@deepchat/mobile-runtime");
            Files.createDirectories(bridge.toPath());
            writeText(new File(bridge, "package.json"),
                    "{\"name\":\"@deepchat/mobile-runtime\",\"version\":\"1.0.0\",\"type\":\"module\",\"exports\":\"./bridge.mjs\"}");
            copyAsset(context, "bridge.mjs", new File(bridge, "bridge.mjs"));
            Os.setenv("HOME", home.getAbsolutePath(), true);
            Os.setenv("DSH_HOME", home.getAbsolutePath(), true);
            Os.setenv("TMPDIR", context.getCacheDir().getAbsolutePath(), true);
            Os.setenv("TZ", TimeZone.getDefault().getID(), true);
            Os.setenv("NO_COLOR", "1", true);
            Os.setenv("DEEPCHAT_ANDROID_PACKAGE", context.getPackageName(), true);

            String[] args = {
                    "--expose-internals", "--preserve-symlinks", "--require", new File(runtime, "probe-env.cjs").getPath(),
                    new File(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js").getPath(),
                    "--profile", "deepchat"
            };
            ParcelFileDescriptor[] stdin = ParcelFileDescriptor.createPipe();
            ParcelFileDescriptor[] stdout = ParcelFileDescriptor.createPipe();
            ParcelFileDescriptor[] stderr = ParcelFileDescriptor.createPipe();
            int inputFd = stdin[0].detachFd();
            int outputFd = stdout[1].detachFd();
            int errorFd = stderr[1].detachFd();
            input = new ParcelFileDescriptor.AutoCloseOutputStream(stdin[1]);
            nodeStarted = true;
            new Thread(() -> readFrames(stdout[0]), "deepseek-account-events").start();
            new Thread(() -> {
                try (InputStream errors = new ParcelFileDescriptor.AutoCloseInputStream(stderr[0])) {
                    byte[] buffer = new byte[8192];
                    while (errors.read(buffer) != -1) { }
                } catch (IOException ignored) { }
            }, "deepseek-account-stderr").start();
            new Thread(null, () -> {
                try {
                    NodeRuntime.nativeStart(args, inputFd, outputFd, errorFd);
                } catch (LinkageError | RuntimeException ignored) {
                    // Pending calls receive a runtime error below.
                } finally {
                    stop();
                }
            }, "deepseek-account-node", 16L * 1024 * 1024).start();
        }

        private void readFrames(ParcelFileDescriptor stdout) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new ParcelFileDescriptor.AutoCloseInputStream(stdout), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!line.startsWith("{")) continue;
                    JSONObject frame = new JSONObject(line);
                    String id = frame.optString("id");
                    Pending request = pending.get(id);
                    if (request == null) continue;
                    if (frame.has("chunk")) {
                        JSObject chunk = new JSObject(line);
                        request.plugin.deliver(() -> request.plugin.notifyListeners("chatChunk", chunk));
                    } else if (remove(id, request)) {
                        JSONObject error = frame.optJSONObject("error");
                        if (error != null) {
                            JSObject data = new JSObject(error.toString());
                            request.plugin.deliver(() -> request.call.reject("DeepSeek account operation failed",
                                    error.optString("code"), null, data));
                        } else {
                            JSObject result = new JSObject(frame.getJSONObject("result").toString());
                            request.plugin.deliver(() -> request.call.resolve(result));
                        }
                    }
                }
            } catch (Exception ignored) {
                stop();
            }
        }

        private synchronized void stop() {
            OutputStream stream = input;
            input = null;
            if (stream != null) {
                try { stream.close(); } catch (IOException ignored) { }
            }
            pending.forEach((id, request) -> {
                if (remove(id, request)) {
                    request.plugin.deliver(() -> request.call.reject("DeepSeek account runtime stopped", "ACCOUNT_RUNTIME"));
                }
            });
        }

        private static void extract(Context context, File runtime) throws IOException {
            String root = runtime.getCanonicalPath() + File.separator;
            var zodLinks = new ArrayList<Path>();
            try (ZipInputStream zip = new ZipInputStream(context.getAssets().open(ASSETS + "harness.zip"))) {
                byte[] buffer = new byte[65536];
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    String name = entry.getName();
                    if (!name.startsWith("node_modules/") && !name.equals("probe-env.cjs")) continue;
                    File target = new File(runtime, name);
                    if (!target.getCanonicalPath().startsWith(root)) throw new IOException("Invalid runtime archive");
                    if (name.matches("node_modules/@deepseek-ai/[^/]+/node_modules/\\.deepchat-zod-link")) {
                        zodLinks.add(target.toPath().resolveSibling("zod"));
                    } else if (entry.isDirectory()) {
                        Files.createDirectories(target.toPath());
                    } else {
                        Files.createDirectories(target.getParentFile().toPath());
                        try (OutputStream out = Files.newOutputStream(target.toPath())) {
                            int count;
                            while ((count = zip.read(buffer)) != -1) out.write(buffer, 0, count);
                        }
                    }
                }
            }
            if (!zodLinks.isEmpty()) {
                Path shared = runtime.toPath().resolve("node_modules/.deepchat-zod-4.6.6");
                if (!Files.isRegularFile(shared.resolve("package.json"))) throw new IOException("Missing shared Zod package");
                for (Path link : zodLinks) {
                    Files.createDirectories(link.getParent());
                    Files.createSymbolicLink(link, link.getParent().relativize(shared));
                }
            }
        }

        private static void writeText(File target, String text) throws IOException {
            Files.write(target.toPath(), text.getBytes(StandardCharsets.UTF_8));
        }

        private static void copyAsset(Context context, String name, File target) throws IOException {
            try (InputStream asset = context.getAssets().open(ASSETS + name)) {
                Files.copy(asset, target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        }

        private static void deleteTree(File path) throws IOException {
            File[] children = Files.isSymbolicLink(path.toPath()) ? null : path.listFiles();
            if (children != null) {
                for (File child : children) deleteTree(child);
            }
            Files.deleteIfExists(path.toPath());
        }
    }
}
