package app.deepchat.mobile;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
        name = "NativeExport",
        permissions = {
            @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
        }
)
public final class NativeExportPlugin extends Plugin {
    private static final long MAX_FILE_BYTES = 32L * 1024 * 1024;
    private static final int MAX_SHARE_FILES = 32;
    private static final long SHARE_CACHE_TTL = 24 * 60 * 60_000L;
    private static final String EXPORT_DIRECTORY = "DeepChat";
    private static final String SHARE_DIRECTORY = "export-share";
    private static final int PRINT_TIMEOUT_MS = 20_000;
    private static final int PRINT_JOB_TIMEOUT_MS = 10 * 60_000;
    private static final int IMAGE_WIDTH_CSS = 720;
    private static final int IMAGE_TARGET_WIDTH_PX = 1080;
    private static final int IMAGE_SLICE_CSS_HEIGHT = 6000;
    private static final int MAX_IMAGE_SLICES = 24;
    private static final long MAX_CANVAS_PIXELS = 18_000_000L;
    private static final long IMAGE_SLICE_TIMEOUT_MS = 20_000L;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private WebView printView;
    private PluginCall printCall;
    private boolean printPageReady;
    private Runnable printTimeout;
    private final Runnable printJobTimeout = () -> finishPrint("PRINT_TIMEOUT", "Printing timed out");
    private ImageExportJob imageExportJob;

    private static final class SavedFile {
        final String fileName;
        final String uri;

        SavedFile(String fileName, String uri) {
            this.fileName = fileName;
            this.uri = uri;
        }

        JSObject toJSObject() {
            return new JSObject().put("fileName", fileName).put("uri", uri);
        }
    }

    private static final class ImageExportJob {
        final PluginCall call;
        final String html;
        final String fileNameBase;
        final String background;
        final int backgroundColor;
        final int heightCss;
        final int sliceCount;
        final boolean share;
        final ArrayList<SavedFile> savedFiles = new ArrayList<>();
        final ArrayList<Uri> uris = new ArrayList<>();
        int sliceIndex;
        WebView webView;
        Runnable timeout;
        File shareDirectory;
        boolean done;

        ImageExportJob(
                PluginCall call,
                String html,
                String fileNameBase,
                String background,
                int backgroundColor,
                int heightCss,
                boolean share
        ) {
            this.call = call;
            this.html = html;
            this.fileNameBase = fileNameBase;
            this.background = background;
            this.backgroundColor = backgroundColor;
            this.heightCss = heightCss;
            this.share = share;
            this.sliceCount = (heightCss + IMAGE_SLICE_CSS_HEIGHT - 1) / IMAGE_SLICE_CSS_HEIGHT;
        }
    }

    @Override
    public void load() {
        cleanShareCache();
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        destroyPrintView();
        failImageExport(imageExportJob, "IMAGE_RENDER_FAILED", "Image export was interrupted");
        super.handleOnDestroy();
    }

    private void cleanShareCache() {
        File directory = shareCacheDirectory();
        File[] entries = directory.listFiles();
        if (entries == null) return;
        long cutoff = System.currentTimeMillis() - SHARE_CACHE_TTL;
        for (File entry : entries) {
            if (entry.lastModified() < cutoff) deleteRecursively(entry);
        }
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }

    private File shareCacheDirectory() {
        return new File(getContext().getCacheDir(), SHARE_DIRECTORY);
    }

    private static String sanitizeFileName(String value) {
        String name = value == null ? "" : value.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[\\p{Cntrl}<>:\"/\\\\|?*]+", "-").trim();
        while (name.startsWith(".")) name = name.substring(1).trim();
        if (name.isEmpty()) name = "DeepChat-export";
        if (name.length() > 120) {
            int dot = name.lastIndexOf('.');
            String extension = dot > 0 && name.length() - dot <= 12 ? name.substring(dot) : "";
            name = name.substring(0, 120 - extension.length()) + extension;
        }
        return name;
    }

    private static String sanitizeMime(String value, String fallback) {
        if (value != null) {
            int parameter = value.indexOf(';');
            String base = (parameter >= 0 ? value.substring(0, parameter) : value).trim();
            if (base.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+*-]+")) {
                return base;
            }
        }
        return fallback;
    }

    private static byte[] decodeBase64(String value) {
        if (value == null) throw new IllegalArgumentException("Missing file data");
        int comma = value.indexOf(',');
        String payload = value.startsWith("data:") && comma >= 0 ? value.substring(comma + 1) : value;
        if (payload.length() > MAX_FILE_BYTES * 2) {
            throw new IllegalArgumentException("File is too large");
        }
        byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
        if (bytes.length > MAX_FILE_BYTES) throw new IllegalArgumentException("File is too large");
        return bytes;
    }

    private static String inputErrorCode(Exception error) {
        return "File is too large".equals(error.getMessage())
                ? "FILE_TOO_LARGE"
                : "INVALID_INPUT";
    }

    private static String inputErrorMessage(Exception error) {
        String message = error.getMessage();
        return message == null ? "Invalid input" : message;
    }

    private boolean legacyStorageNeedsPermission() {
        return Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && getPermissionState("storage") != PermissionState.GRANTED;
    }

    @PluginMethod
    public void saveText(PluginCall call) {
        if (legacyStorageNeedsPermission()) {
            requestPermissionForAlias("storage", call, "saveTextPermission");
            return;
        }
        saveTextNow(call);
    }

    @PermissionCallback
    public void saveTextPermission(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("Storage permission is required", "STORAGE_PERMISSION");
            return;
        }
        saveTextNow(call);
    }

    private void saveTextNow(PluginCall call) {
        String name = sanitizeFileName(call.getString("fileName", "DeepChat-export.txt"));
        String mime = sanitizeMime(call.getString("mimeType"), "text/plain");
        executor.execute(() -> {
            String content = call.getString("content");
            if (content == null) {
                call.reject("Missing text content", "INVALID_INPUT");
                return;
            }
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_FILE_BYTES) {
                call.reject("File is too large", "FILE_TOO_LARGE");
                return;
            }
            try {
                SavedFile saved = saveBytes(name, mime, bytes, false);
                call.resolve(new JSObject().put("files", new JSArray().put(saved.toJSObject())));
            } catch (IOException | SecurityException error) {
                call.reject("Could not save file", "STORAGE_WRITE");
            }
        });
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        if (legacyStorageNeedsPermission()) {
            requestPermissionForAlias("storage", call, "saveFilePermission");
            return;
        }
        saveFileNow(call);
    }

    @PermissionCallback
    public void saveFilePermission(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("Storage permission is required", "STORAGE_PERMISSION");
            return;
        }
        saveFileNow(call);
    }

    private void saveFileNow(PluginCall call) {
        String name = sanitizeFileName(call.getString("fileName", "DeepChat-export.bin"));
        String mime = sanitizeMime(call.getString("mimeType"), "application/octet-stream");
        executor.execute(() -> {
            try {
                byte[] bytes = decodeBase64(call.getString("base64"));
                SavedFile saved = saveBytes(name, mime, bytes, false);
                call.resolve(new JSObject().put("files", new JSArray().put(saved.toJSObject())));
            } catch (IllegalArgumentException error) {
                call.reject(inputErrorMessage(error), inputErrorCode(error));
            } catch (IOException | SecurityException error) {
                call.reject("Could not save file", "STORAGE_WRITE");
            }
        });
    }

    @PluginMethod
    public void saveImages(PluginCall call) {
        if (legacyStorageNeedsPermission()) {
            requestPermissionForAlias("storage", call, "saveImagesPermission");
            return;
        }
        saveImagesNow(call);
    }

    @PermissionCallback
    public void saveImagesPermission(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("Storage permission is required", "STORAGE_PERMISSION");
            return;
        }
        saveImagesNow(call);
    }

    private void saveImagesNow(PluginCall call) {
        executor.execute(() -> {
            JSArray files = call.getArray("files");
            if (files == null || files.length() == 0 || files.length() > MAX_SHARE_FILES) {
                call.reject("Invalid image list", "INVALID_INPUT");
                return;
            }
            try {
                JSArray saved = new JSArray();
                for (int index = 0; index < files.length(); index++) {
                    JSONObject file = files.getJSONObject(index);
                    String mime = sanitizeMime(file.optString("mimeType"), "image/png");
                    if (!mime.startsWith("image/")) {
                        throw new IllegalArgumentException("Only images can be saved to the gallery");
                    }
                    String name = sanitizeFileName(
                            file.optString("fileName", "DeepChat-image.png")
                    );
                    byte[] bytes = decodeBase64(file.optString("base64"));
                    saved.put(saveBytes(name, mime, bytes, true).toJSObject());
                }
                call.resolve(new JSObject().put("files", saved));
            } catch (JSONException | IllegalArgumentException error) {
                call.reject(inputErrorMessage(error), inputErrorCode(error));
            } catch (IOException | SecurityException error) {
                call.reject("Could not save image", "STORAGE_WRITE");
            }
        });
    }

    @PluginMethod
    public void saveHtmlImages(PluginCall call) {
        if (legacyStorageNeedsPermission()) {
            requestPermissionForAlias("storage", call, "saveHtmlImagesPermission");
            return;
        }
        startHtmlImageExport(call, false);
    }

    @PermissionCallback
    public void saveHtmlImagesPermission(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("Storage permission is required", "STORAGE_PERMISSION");
            return;
        }
        startHtmlImageExport(call, false);
    }

    @PluginMethod
    public void shareHtmlImages(PluginCall call) {
        startHtmlImageExport(call, true);
    }

    private void startHtmlImageExport(PluginCall call, boolean share) {
        if (imageExportJob != null) {
            call.reject("An image export is already running", "IMAGE_BUSY");
            return;
        }
        String html = call.getString("html");
        Integer heightCss = call.getInt("heightCss");
        if (html == null || html.isEmpty()) {
            call.reject("Missing export document", "INVALID_INPUT");
            return;
        }
        if (html.length() > MAX_FILE_BYTES) {
            call.reject("Export document is too large", "FILE_TOO_LARGE");
            return;
        }
        if (heightCss == null || heightCss <= 0) {
            call.reject("Invalid image height", "INVALID_INPUT");
            return;
        }
        int sliceCount = (heightCss + IMAGE_SLICE_CSS_HEIGHT - 1) / IMAGE_SLICE_CSS_HEIGHT;
        if (sliceCount > MAX_IMAGE_SLICES) {
            call.reject("Export image has too many slices", "IMAGE_TOO_LARGE");
            return;
        }
        double scale = (double) IMAGE_TARGET_WIDTH_PX / IMAGE_WIDTH_CSS;
        long slicePixels = (long) Math.ceil(IMAGE_TARGET_WIDTH_PX * IMAGE_SLICE_CSS_HEIGHT * scale);
        if (slicePixels > MAX_CANVAS_PIXELS) {
            call.reject("Export image exceeds the canvas budget", "IMAGE_TOO_LARGE");
            return;
        }
        String background = call.getString("background", "#ffffff");
        int backgroundColor;
        try {
            backgroundColor = Color.parseColor(background);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid background color", "INVALID_INPUT");
            return;
        }
        String fileNameBase = sanitizeFileName(
                call.getString("fileNameBase", "DeepChat-image")
        );
        if (fileNameBase.toLowerCase().endsWith(".png")) {
            fileNameBase = fileNameBase.substring(0, fileNameBase.length() - 4);
        }
        if (fileNameBase.isEmpty()) fileNameBase = "DeepChat-image";

        ImageExportJob job = new ImageExportJob(
                call,
                html,
                fileNameBase,
                background,
                backgroundColor,
                heightCss,
                share
        );
        if (share) {
            File directory = new File(shareCacheDirectory(), UUID.randomUUID().toString());
            if (!directory.isDirectory() && !directory.mkdirs()) {
                call.reject("Could not create share directory", "SHARE_WRITE");
                return;
            }
            job.shareDirectory = directory;
        }
        call.setKeepAlive(true);
        imageExportJob = job;
        mainHandler.post(() -> renderImageSlice(job));
    }

    private void renderImageSlice(ImageExportJob job) {
        if (imageExportJob != job || job.done) return;
        if (job.sliceIndex >= job.sliceCount) {
            finishImageExport(job);
            return;
        }
        if (getActivity() == null || getActivity().isFinishing()) {
            failImageExport(job, "IMAGE_RENDER_FAILED", "Activity is unavailable");
            return;
        }
        int offsetCss = job.sliceIndex * IMAGE_SLICE_CSS_HEIGHT;
        int currentCssHeight = Math.min(
                IMAGE_SLICE_CSS_HEIGHT,
                job.heightCss - offsetCss
        );
        double scale = (double) IMAGE_TARGET_WIDTH_PX / IMAGE_WIDTH_CSS;
        int widthPx = IMAGE_TARGET_WIDTH_PX;
        int heightPx = Math.max(1, (int) Math.ceil(currentCssHeight * scale));
        WebView webView = new WebView(getContext());
        job.webView = webView;
        webView.setBackgroundColor(job.backgroundColor);
        webView.setFocusable(false);
        webView.setFocusableInTouchMode(false);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBlockNetworkLoads(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (imageExportJob != job || job.done || job.webView != view) return;
                mainHandler.removeCallbacks(job.timeout);
                view.postVisualStateCallback(0L, new WebView.VisualStateCallback() {
                    @Override
                    public void onComplete(long requestId) {
                        if (imageExportJob != job || job.done) return;
                        mainHandler.postDelayed(() -> captureImageSlice(job), 350L);
                    }
                });
            }
        });
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(widthPx, heightPx);
        getActivity().addContentView(webView, params);
        webView.setTranslationX(-widthPx - 1_000f);
        webView.setTranslationY(0f);
        webView.loadDataWithBaseURL(
                "https://localhost/",
                imageSliceHtml(job, offsetCss, currentCssHeight),
                "text/html",
                "UTF-8",
                null
        );
        job.timeout = () -> failImageExport(
                job,
                "IMAGE_RENDER_TIMEOUT",
                "Share image did not finish rendering"
        );
        mainHandler.postDelayed(job.timeout, IMAGE_SLICE_TIMEOUT_MS);
    }

    private String imageSliceHtml(ImageExportJob job, int offsetCss, int currentCssHeight) {
        String style = "<style id=\"deepchat-export-slice\">"
                + "html,body{margin:0!important;padding:0!important;width:"
                + IMAGE_WIDTH_CSS
                + "px!important;height:"
                + currentCssHeight
                + "px!important;min-height:0!important;overflow:hidden!important;background:"
                + job.background
                + "!important;}"
                + "body>article{position:absolute!important;left:0!important;top:-"
                + offsetCss
                + "px!important;width:"
                + IMAGE_WIDTH_CSS
                + "px!important;max-width:"
                + IMAGE_WIDTH_CSS
                + "px!important;margin:0!important;}"
                + "*{animation:none!important;transition:none!important;}"
                + "</style>";
        int head = job.html.indexOf("</head>");
        if (head < 0) return style + job.html;
        return job.html.substring(0, head) + style + job.html.substring(head);
    }

    private void captureImageSlice(ImageExportJob job) {
        if (imageExportJob != job || job.done) return;
        WebView webView = job.webView;
        if (webView == null) {
            failImageExport(job, "IMAGE_RENDER_FAILED", "Capture WebView is unavailable");
            return;
        }
        int offsetCss = job.sliceIndex * IMAGE_SLICE_CSS_HEIGHT;
        int currentCssHeight = Math.min(
                IMAGE_SLICE_CSS_HEIGHT,
                job.heightCss - offsetCss
        );
        double scale = (double) IMAGE_TARGET_WIDTH_PX / IMAGE_WIDTH_CSS;
        int widthPx = IMAGE_TARGET_WIDTH_PX;
        int heightPx = Math.max(1, (int) Math.ceil(currentCssHeight * scale));
        final Bitmap bitmap;
        try {
            bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(job.backgroundColor);
            webView.draw(canvas);
        } catch (RuntimeException error) {
            failImageExport(job, "IMAGE_RENDER_FAILED", "Could not render share image");
            return;
        }
        int index = job.sliceIndex;
        String fileName = job.fileNameBase
                + (job.sliceCount > 1 ? "-" + (index + 1) : "")
                + ".png";
        executor.execute(() -> {
            byte[] bytes;
            try (ByteArrayOutputStream stream = new ByteArrayOutputStream()) {
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                    bitmap.recycle();
                    failImageExportAsync(job, "IMAGE_RENDER_FAILED", "Could not encode share image");
                    return;
                }
                bytes = stream.toByteArray();
            } catch (IOException | RuntimeException error) {
                bitmap.recycle();
                failImageExportAsync(job, "IMAGE_RENDER_FAILED", "Could not encode share image");
                return;
            } finally {
                bitmap.recycle();
            }
            try {
                if (job.share) {
                    File target = uniqueFile(job.shareDirectory, fileName);
                    try (FileOutputStream stream = new FileOutputStream(target)) {
                        stream.write(bytes);
                    }
                    job.uris.add(FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            target
                    ));
                } else {
                    job.savedFiles.add(saveBytes(fileName, "image/png", bytes, true));
                }
            } catch (IOException | SecurityException error) {
                failImageExportAsync(job, "STORAGE_WRITE", "Could not save share image");
                return;
            }
            mainHandler.post(() -> onImageSliceSaved(job));
        });
    }

    private void onImageSliceSaved(ImageExportJob job) {
        if (imageExportJob != job || job.done) return;
        destroyImageWebView(job);
        job.sliceIndex++;
        if (job.sliceIndex >= job.sliceCount) {
            finishImageExport(job);
        } else {
            renderImageSlice(job);
        }
    }

    private void finishImageExport(ImageExportJob job) {
        if (imageExportJob != job || job.done) return;
        job.done = true;
        mainHandler.removeCallbacks(job.timeout);
        destroyImageWebView(job);
        imageExportJob = null;
        if (job.share) {
            openShareSheet(job.call, job.uris, "image/png");
            return;
        }
        JSArray files = new JSArray();
        for (SavedFile file : job.savedFiles) files.put(file.toJSObject());
        job.call.resolve(new JSObject().put("files", files));
    }

    private void failImageExportAsync(ImageExportJob job, String code, String message) {
        mainHandler.post(() -> failImageExport(job, code, message));
    }

    private void failImageExport(ImageExportJob job, String code, String message) {
        if (job == null || imageExportJob != job || job.done) return;
        job.done = true;
        mainHandler.removeCallbacks(job.timeout);
        destroyImageWebView(job);
        if (job.shareDirectory != null) deleteRecursively(job.shareDirectory);
        imageExportJob = null;
        job.call.reject(message, code);
    }

    private void destroyImageWebView(ImageExportJob job) {
        WebView webView = job.webView;
        job.webView = null;
        if (webView == null) return;
        ViewGroup parent = webView.getParent() instanceof ViewGroup
                ? (ViewGroup) webView.getParent()
                : null;
        if (parent != null) parent.removeView(webView);
        webView.stopLoading();
        webView.loadUrl("about:blank");
        webView.destroy();
    }

    private SavedFile saveBytes(String name, String mime, byte[] bytes, boolean gallery)
            throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return saveWithMediaStore(name, mime, bytes, gallery);
        }
        return saveLegacy(name, mime, bytes, gallery);
    }

    private SavedFile saveWithMediaStore(String name, String mime, byte[] bytes, boolean gallery)
            throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        Uri collection = gallery
                ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String relativePath = (gallery ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS)
                + "/" + EXPORT_DIRECTORY;
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(collection, values);
        if (uri == null) throw new IOException("MediaStore insert failed");
        boolean success = false;
        try {
            try (OutputStream stream = resolver.openOutputStream(uri, "w")) {
                if (stream == null) throw new IOException("MediaStore stream unavailable");
                stream.write(bytes);
                stream.flush();
            }
            ContentValues complete = new ContentValues();
            complete.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, complete, null, null);
            success = true;
            return new SavedFile(name, uri.toString());
        } finally {
            if (!success) resolver.delete(uri, null, null);
        }
    }

    private SavedFile saveLegacy(String name, String mime, byte[] bytes, boolean gallery)
            throws IOException {
        File root = Environment.getExternalStoragePublicDirectory(
                gallery ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS
        );
        File directory = new File(root, EXPORT_DIRECTORY);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Could not create export directory");
        }
        File file = uniqueFile(directory, name);
        try (FileOutputStream stream = new FileOutputStream(file)) {
            stream.write(bytes);
            stream.flush();
        }
        MediaScannerConnection.scanFile(
                getContext(),
                new String[] { file.getAbsolutePath() },
                new String[] { mime },
                null
        );
        return new SavedFile(file.getName(), Uri.fromFile(file).toString());
    }

    private static File uniqueFile(File directory, String name) {
        File candidate = new File(directory, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int index = 2; index < 10_000; index++) {
            candidate = new File(directory, base + " (" + index + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
        return new File(directory, base + "-" + UUID.randomUUID() + extension);
    }

    @PluginMethod
    public void shareFiles(PluginCall call) {
        executor.execute(() -> {
            JSArray files = call.getArray("files");
            if (files == null || files.length() == 0 || files.length() > MAX_SHARE_FILES) {
                call.reject("Invalid file list", "INVALID_INPUT");
                return;
            }
            try {
                File directory = new File(
                        shareCacheDirectory(),
                        UUID.randomUUID().toString()
                );
                if (!directory.isDirectory() && !directory.mkdirs()) {
                    throw new IOException("Could not create share directory");
                }
                ArrayList<Uri> uris = new ArrayList<>();
                String commonMime = null;
                for (int index = 0; index < files.length(); index++) {
                    JSONObject file = files.getJSONObject(index);
                    String name = sanitizeFileName(
                            file.optString("fileName", "DeepChat-export.bin")
                    );
                    String mime = sanitizeMime(
                            file.optString("mimeType"),
                            "application/octet-stream"
                    );
                    byte[] bytes = decodeBase64(file.optString("base64"));
                    File target = uniqueFile(directory, name);
                    try (FileOutputStream stream = new FileOutputStream(target)) {
                        stream.write(bytes);
                    }
                    uris.add(FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            target
                    ));
                    if (commonMime == null) {
                        commonMime = mime;
                    } else if (!commonMime.equals(mime)) {
                        commonMime = "*/*";
                    }
                }
                String mime = commonMime;
                mainHandler.post(() -> openShareSheet(call, uris, mime));
            } catch (JSONException | IllegalArgumentException error) {
                call.reject(inputErrorMessage(error), inputErrorCode(error));
            } catch (IOException | SecurityException error) {
                call.reject("Could not prepare shared files", "SHARE_WRITE");
            }
        });
    }

    private void openShareSheet(PluginCall call, ArrayList<Uri> uris, String mime) {
        try {
            Intent intent = new Intent(
                    uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE
            );
            intent.setType(mime);
            if (uris.size() == 1) {
                intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            ClipData clip = ClipData.newRawUri("DeepChat export", uris.get(0));
            for (int index = 1; index < uris.size(); index++) {
                clip.addItem(new ClipData.Item(uris.get(index)));
            }
            intent.setClipData(clip);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            String title = call.getString("title", "Deep Chat");
            getActivity().startActivity(Intent.createChooser(intent, title));
            call.resolve();
        } catch (ActivityNotFoundException error) {
            call.reject("No compatible app can receive these files", "SHARE_UNAVAILABLE");
        }
    }

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.isEmpty()) {
            call.reject("Missing print document", "INVALID_INPUT");
            return;
        }
        if (html.length() > MAX_FILE_BYTES) {
            call.reject("Print document is too large", "FILE_TOO_LARGE");
            return;
        }
        if (printCall != null) {
            call.reject("A print job is already open", "PRINT_BUSY");
            return;
        }
        String title = call.getString("title", "Deep Chat");
        String baseUrl = call.getString("baseUrl", "https://localhost/");
        call.setKeepAlive(true);
        printCall = call;
        printPageReady = false;
        mainHandler.post(() -> startPrintWebView(call, title, baseUrl, html));
    }

    private void startPrintWebView(PluginCall call, String title, String baseUrl, String html) {
        if (getActivity() == null || getActivity().isFinishing()) {
            finishPrint("PRINT_FAILED", "Activity is unavailable");
            return;
        }
        WebView webView = new WebView(getContext());
        printView = webView;
        webView.setBackgroundColor(Color.WHITE);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBlockNetworkLoads(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (printPageReady || printCall != call) return;
                printPageReady = true;
                mainHandler.postDelayed(() -> {
                    if (printCall != call) return;
                    openPrintDialog(title);
                }, 500);
            }
        });
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(1080, 1920);
        getActivity().addContentView(webView, params);
        webView.setAlpha(0f);
        webView.setTranslationX(-20_000f);
        webView.loadDataWithBaseURL(baseUrl, html, "text/html", "UTF-8", null);
        printTimeout = () -> {
            if (!printPageReady) finishPrint("PRINT_FAILED", "Print document did not finish loading");
        };
        mainHandler.postDelayed(printTimeout, PRINT_TIMEOUT_MS);
    }

    private void openPrintDialog(String title) {
        WebView webView = printView;
        if (webView == null) {
            finishPrint("PRINT_FAILED", "Print WebView is unavailable");
            return;
        }
        try {
            PrintManager manager = (PrintManager) getContext().getSystemService(
                    android.content.Context.PRINT_SERVICE
            );
            if (manager == null) {
                finishPrint("PRINT_UNAVAILABLE", "Print service is unavailable");
                return;
            }
            PrintDocumentAdapter delegate = webView.createPrintDocumentAdapter(title);
            PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                @Override
                public void onStart() {
                    delegate.onStart();
                }

                @Override
                public void onLayout(
                        PrintAttributes oldAttributes,
                        PrintAttributes newAttributes,
                        android.os.CancellationSignal cancellationSignal,
                        LayoutResultCallback callback,
                        android.os.Bundle extras
                ) {
                    delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
                }

                @Override
                public void onWrite(
                        android.print.PageRange[] pages,
                        android.os.ParcelFileDescriptor destination,
                        android.os.CancellationSignal cancellationSignal,
                        WriteResultCallback callback
                ) {
                    delegate.onWrite(pages, destination, cancellationSignal, callback);
                }

                @Override
                public void onFinish() {
                    delegate.onFinish();
                    finishPrint(null, null);
                }
            };
            PrintAttributes attributes = new PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build();
            manager.print(title, adapter, attributes);
            mainHandler.postDelayed(printJobTimeout, PRINT_JOB_TIMEOUT_MS);
        } catch (RuntimeException error) {
            finishPrint("PRINT_FAILED", "Could not open the print dialog");
        }
    }

    private void finishPrint(String code, String message) {
        PluginCall call = printCall;
        printCall = null;
        printPageReady = false;
        if (printTimeout != null) {
            mainHandler.removeCallbacks(printTimeout);
            printTimeout = null;
        }
        mainHandler.removeCallbacks(printJobTimeout);
        destroyPrintView();
        if (call == null) return;
        if (code == null) {
            call.resolve();
        } else {
            call.reject(message, code);
        }
    }

    private void destroyPrintView() {
        WebView webView = printView;
        printView = null;
        if (webView == null) return;
        ViewGroup parent = webView.getParent() instanceof ViewGroup
                ? (ViewGroup) webView.getParent()
                : null;
        if (parent != null) parent.removeView(webView);
        webView.stopLoading();
        webView.loadUrl("about:blank");
        webView.destroy();
    }
}
