package app.deepchat.mobile;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
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
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

@CapacitorPlugin(name = "ShareIntake")
public class ShareIntakePlugin extends Plugin {
    private static final String EVENT_NAME = "intake";
    private static final String CACHE_DIRECTORY = "shared_intake";
    private static final int MAX_PENDING_INTAKES = 4;

    private static final String ERROR_TOO_MANY_FILES = "TOO_MANY_FILES";
    private static final String ERROR_FILE_TOO_LARGE = "FILE_TOO_LARGE";
    private static final String ERROR_TOTAL_TOO_LARGE = "TOTAL_TOO_LARGE";
    private static final String ERROR_TEXT_TOO_LONG = "TEXT_TOO_LONG";
    private static final String ERROR_UNSUPPORTED = "UNSUPPORTED";
    private static final String ERROR_READ_FAILED = "READ_FAILED";

    private final Object lock = new Object();
    private final ArrayDeque<JSObject> pending = new ArrayDeque<>();
    private final Map<String, File> intakeDirectories = new HashMap<>();
    private final ExecutorService intakeExecutor = Executors.newSingleThreadExecutor();

    private static final class IntakeFailure extends Exception {
        final String code;

        IntakeFailure(String code) {
            this.code = code;
        }
    }

    private static final class SharedFileResult {
        final String name;
        final String mimeType;
        final long size;
        final File file;

        SharedFileResult(String name, String mimeType, long size, File file) {
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
            this.file = file;
        }
    }

    @Override
    public void load() {
        submit(this::cleanupOrphanedIntakeDirectories);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        JSObject shortcut = shortcutIntent(intent);
        if (shortcut != null) {
            publish(shortcut);
            return;
        }
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)
                || Intent.ACTION_SEND_MULTIPLE.equals(action)
                || Intent.ACTION_PROCESS_TEXT.equals(action)) {
            submit(() -> processIntent(intent));
        }
    }

    @PluginMethod
    public void consumePendingIntake(PluginCall call) {
        JSObject next;
        synchronized (lock) {
            next = pending.pollFirst();
        }
        JSObject result = new JSObject();
        if (next != null) result.put("intake", next);
        call.resolve(result);
    }

    @PluginMethod
    public void releaseIntake(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.resolve();
            return;
        }
        discardPending(id);
        File directory;
        synchronized (lock) {
            directory = intakeDirectories.remove(id);
        }
        call.resolve();
        submit(() -> deleteDirectory(directory));
    }

    private void submit(Runnable task) {
        try {
            intakeExecutor.execute(task);
        } catch (RejectedExecutionException ignored) {
            // The activity is already being torn down.
        }
    }

    private void processIntent(Intent intent) {
        synchronized (lock) {
            if (pending.size() >= MAX_PENDING_INTAKES) return;
        }
        String id = "intake-" + UUID.randomUUID().toString();
        String action = intent.getAction();
        File intakeDirectory = null;
        try {
            String text = intentText(intent, action);
            if (text != null && ShareIntakePolicy.exceedsTextLength(text.length())) {
                throw new IntakeFailure(ERROR_TEXT_TOO_LONG);
            }

            Set<Uri> uris = intentUris(intent, action);
            if (ShareIntakePolicy.exceedsFileCount(uris.size())) {
                throw new IntakeFailure(ERROR_TOO_MANY_FILES);
            }
            if (!Intent.ACTION_PROCESS_TEXT.equals(action)
                    && (text == null || text.trim().isEmpty())
                    && uris.isEmpty()) {
                throw new IntakeFailure(ERROR_UNSUPPORTED);
            }
            if (Intent.ACTION_PROCESS_TEXT.equals(action)
                    && (text == null || text.trim().isEmpty())) {
                throw new IntakeFailure(ERROR_UNSUPPORTED);
            }

            List<SharedFileResult> files = new ArrayList<>();
            if (!uris.isEmpty()) {
                File root = intakeRoot();
                intakeDirectory = new File(root, UUID.randomUUID().toString());
                if (!intakeDirectory.mkdirs()
                        || !ShareIntakePolicy.isWithinDirectory(root, intakeDirectory)) {
                    throw new IntakeFailure(ERROR_READ_FAILED);
                }
                long total = 0;
                for (Uri uri : uris) {
                    SharedFileResult file = copySharedFile(uri, intakeDirectory, total);
                    total += file.size;
                    files.add(file);
                }
                synchronized (lock) {
                    intakeDirectories.put(id, intakeDirectory);
                }
            }

            JSObject payload = basePayload(id, Intent.ACTION_PROCESS_TEXT.equals(action)
                    ? "process-text" : "share");
            payload.put("text", text == null ? "" : text);
            JSArray resultFiles = new JSArray();
            for (SharedFileResult file : files) {
                JSObject entry = new JSObject();
                entry.put("uri", Uri.fromFile(file.file).toString());
                entry.put("name", file.name);
                entry.put("mimeType", file.mimeType);
                entry.put("size", file.size);
                resultFiles.put(entry);
            }
            payload.put("files", resultFiles);
            if (!publish(payload)) {
                synchronized (lock) {
                    intakeDirectories.remove(id);
                }
                deleteDirectory(intakeDirectory);
            }
        } catch (IntakeFailure failure) {
            forgetIntake(id, intakeDirectory);
            deleteDirectory(intakeDirectory);
            publish(failurePayload(id, failure.code));
        } catch (Exception ignored) {
            forgetIntake(id, intakeDirectory);
            deleteDirectory(intakeDirectory);
            publish(failurePayload(id, ERROR_READ_FAILED));
        }
    }

    private void forgetIntake(String id, File directory) {
        if (directory == null) return;
        synchronized (lock) {
            intakeDirectories.remove(id);
        }
    }

    private JSObject shortcutIntent(Intent intent) {
        if (!Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        Uri data = intent.getData();
        if (data == null) return null;
        String shortcut = ShareIntakePolicy.shortcutActionFor(
                data.getScheme(),
                data.getHost(),
                data.getQueryParameter("type"),
                getContext().getPackageName()
        );
        if (shortcut == null) return null;
        JSObject payload = basePayload("shortcut-" + UUID.randomUUID(), "shortcut");
        payload.put("shortcut", shortcut);
        return payload;
    }

    private static String intentText(Intent intent, String action) {
        CharSequence text;
        if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
        } else {
            text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text == null) {
                ClipData clipData = intent.getClipData();
                if (clipData != null) {
                    for (int index = 0; index < clipData.getItemCount(); index++) {
                        CharSequence clipped = clipData.getItemAt(index).getText();
                        if (clipped != null) {
                            text = clipped;
                            break;
                        }
                    }
                }
            }
        }
        return text == null ? null : text.toString();
    }

    private Set<Uri> intentUris(Intent intent, String action) throws IntakeFailure {
        if (Intent.ACTION_PROCESS_TEXT.equals(action)) return new LinkedHashSet<>();
        LinkedHashSet<Uri> result = new LinkedHashSet<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> values = parcelableUriList(intent, Intent.EXTRA_STREAM);
            if (values != null) result.addAll(values);
        } else {
            Uri value = parcelableUri(intent, Intent.EXTRA_STREAM);
            if (value != null) result.add(value);
        }
        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null) result.add(uri);
            }
        }
        result.remove(null);
        for (Uri uri : result) {
            if (!ShareIntakePolicy.isValidUriScheme(uri.getScheme())) {
                throw new IntakeFailure(ERROR_UNSUPPORTED);
            }
        }
        return result;
    }

    @SuppressWarnings("deprecation")
    private static Uri parcelableUri(Intent intent, String key) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(key, Uri.class);
        }
        return intent.getParcelableExtra(key);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> parcelableUriList(Intent intent, String key) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableArrayListExtra(key, Uri.class);
        }
        return intent.getParcelableArrayListExtra(key);
    }

    private SharedFileResult copySharedFile(Uri uri, File directory, long totalBefore)
            throws IntakeFailure {
        String resolverMime = normalizeType(getContext().getContentResolver().getType(uri));
        String rawName = displayName(uri);
        String name = ShareIntakePolicy.sanitizeDisplayName(rawName, resolverMime);
        String mime = ShareIntakePolicy.mimeForName(name);
        if (!ShareIntakePolicy.isAllowedExtension(ShareIntakePolicy.extensionOf(name))
                || mime == null) {
            throw new IntakeFailure(ERROR_UNSUPPORTED);
        }

        long declaredSize = displaySize(uri);
        if (ShareIntakePolicy.exceedsFileSize(declaredSize)) {
            throw new IntakeFailure(ERROR_FILE_TOO_LARGE);
        }
        if (declaredSize > 0
                && ShareIntakePolicy.exceedsTotalSize(totalBefore + declaredSize)) {
            throw new IntakeFailure(ERROR_TOTAL_TOO_LARGE);
        }

        File target = uniqueTarget(directory, name);
        name = target.getName();
        if (!ShareIntakePolicy.isWithinDirectory(directory, target)) {
            throw new IntakeFailure(ERROR_UNSUPPORTED);
        }
        long written = copyStream(uri, target, totalBefore);
        return new SharedFileResult(name, mime, written, target);
    }

    private static File uniqueTarget(File directory, String name) {
        File target = new File(directory, name);
        if (!target.exists()) return target;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int index = 2; index < 1000; index++) {
            String candidate = index + "-" + stem + extension;
            target = new File(directory, candidate);
            if (!target.exists()) return target;
        }
        return new File(directory, UUID.randomUUID() + extension);
    }

    private long copyStream(Uri uri, File target, long totalBefore) throws IntakeFailure {
        byte[] buffer = new byte[64 * 1024];
        long written = 0;
        try (InputStream input = openInput(uri);
             OutputStream output = new FileOutputStream(target, false)) {
            if (input == null) throw new IntakeFailure(ERROR_READ_FAILED);
            int read;
            while ((read = input.read(buffer)) != -1) {
                written += read;
                if (ShareIntakePolicy.exceedsFileSize(written)) {
                    throw new IntakeFailure(ERROR_FILE_TOO_LARGE);
                }
                if (ShareIntakePolicy.exceedsTotalSize(totalBefore + written)) {
                    throw new IntakeFailure(ERROR_TOTAL_TOO_LARGE);
                }
                output.write(buffer, 0, read);
            }
            output.flush();
            return written;
        } catch (IntakeFailure failure) {
            target.delete();
            throw failure;
        } catch (Exception error) {
            target.delete();
            throw new IntakeFailure(ERROR_READ_FAILED);
        }
    }

    private InputStream openInput(Uri uri) throws IOException {
        return getContext().getContentResolver().openInputStream(uri);
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(
                uri,
                new String[]{OpenableColumns.DISPLAY_NAME},
                null,
                null,
                null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getString(index);
            }
        } catch (Exception ignored) {
            // Fall back to the URI-provided name.
        }
        return uri.getLastPathSegment();
    }

    private long displaySize(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(
                uri,
                new String[]{OpenableColumns.SIZE},
                null,
                null,
                null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index);
            }
        } catch (Exception ignored) {
            // Unknown size is enforced while streaming.
        }
        return -1L;
    }

    private static String normalizeType(String mimeType) {
        if (mimeType == null) return "";
        int parameters = mimeType.indexOf(';');
        String value = parameters >= 0 ? mimeType.substring(0, parameters) : mimeType;
        return value.trim().toLowerCase(Locale.ROOT);
    }

    private File intakeRoot() throws IntakeFailure {
        File root = new File(getContext().getCacheDir(), CACHE_DIRECTORY);
        if (!root.isDirectory() && !root.mkdirs()) {
            throw new IntakeFailure(ERROR_READ_FAILED);
        }
        return root;
    }

    private boolean publish(JSObject payload) {
        synchronized (lock) {
            if (pending.size() >= MAX_PENDING_INTAKES) return false;
            pending.addLast(payload);
        }
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) return true;
        activity.runOnUiThread(() -> notifyListeners(EVENT_NAME, payload, true));
        return true;
    }

    private static JSObject basePayload(String id, String kind) {
        JSObject payload = new JSObject();
        payload.put("id", id);
        payload.put("kind", kind);
        return payload;
    }

    private static JSObject failurePayload(String id, String code) {
        JSObject payload = basePayload(id, "error");
        payload.put("error", code);
        return payload;
    }

    private void discardPending(String id) {
        synchronized (lock) {
            Iterator<JSObject> iterator = pending.iterator();
            while (iterator.hasNext()) {
                if (id.equals(iterator.next().optString("id"))) iterator.remove();
            }
        }
    }

    private void cleanupOrphanedIntakeDirectories() {
        File root = new File(getContext().getCacheDir(), CACHE_DIRECTORY);
        File[] children = root.listFiles();
        if (children == null) return;
        Set<String> active = new HashSet<>();
        synchronized (lock) {
            for (File directory : intakeDirectories.values()) {
                active.add(directory.getAbsolutePath());
            }
        }
        for (File child : children) {
            if (active.contains(child.getAbsolutePath())) continue;
            deleteDirectory(child);
        }
    }

    private void deleteDirectory(File directory) {
        if (directory == null) return;
        File root = new File(getContext().getCacheDir(), CACHE_DIRECTORY);
        if (!ShareIntakePolicy.isWithinDirectory(root, directory)
                || root.getAbsoluteFile().equals(directory.getAbsoluteFile())) {
            return;
        }
        File[] children = directory.listFiles();
        if (children != null) {
            for (File child : children) deleteDirectory(child);
        }
        directory.delete();
    }

    @Override
    protected void handleOnDestroy() {
        intakeExecutor.shutdownNow();
        super.handleOnDestroy();
    }
}
