package app.deepchat.mobile;

import java.io.File;
import java.io.IOException;
import java.text.Normalizer;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

final class ShareIntakePolicy {
    static final int MAX_FILES = 10;
    static final long MAX_FILE_BYTES = 32L * 1024 * 1024;
    static final long MAX_TOTAL_BYTES = 64L * 1024 * 1024;
    static final int MAX_TEXT_CHARS = 64 * 1024;
    static final int MAX_NAME_CHARS = 96;

    private static final Map<String, String> MIME_BY_EXTENSION;
    private static final Map<String, String> EXTENSION_BY_MIME;

    static {
        Map<String, String> mimeByExtension = new HashMap<>();
        put(mimeByExtension, "png", "image/png");
        put(mimeByExtension, "jpg", "image/jpeg");
        put(mimeByExtension, "jpeg", "image/jpeg");
        put(mimeByExtension, "gif", "image/gif");
        put(mimeByExtension, "webp", "image/webp");
        put(mimeByExtension, "bmp", "image/bmp");
        put(mimeByExtension, "svg", "image/svg+xml");
        put(mimeByExtension, "ico", "image/x-icon");
        put(mimeByExtension, "tif", "image/tiff");
        put(mimeByExtension, "tiff", "image/tiff");
        put(mimeByExtension, "avif", "image/avif");
        put(mimeByExtension, "pdf", "application/pdf");
        put(mimeByExtension, "doc", "application/msword");
        put(mimeByExtension, "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        put(mimeByExtension, "xls", "application/vnd.ms-excel");
        put(mimeByExtension, "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        put(mimeByExtension, "ppt", "application/vnd.ms-powerpoint");
        put(mimeByExtension, "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        put(mimeByExtension, "txt", "text/plain");
        put(mimeByExtension, "md", "text/markdown");
        put(mimeByExtension, "csv", "text/csv");
        put(mimeByExtension, "tsv", "text/tab-separated-values");
        put(mimeByExtension, "html", "text/html");
        put(mimeByExtension, "htm", "text/html");
        put(mimeByExtension, "json", "application/json");
        put(mimeByExtension, "log", "text/plain");
        put(mimeByExtension, "xml", "application/xml");
        put(mimeByExtension, "yaml", "application/yaml");
        put(mimeByExtension, "yml", "application/yaml");
        put(mimeByExtension, "epub", "application/epub+zip");
        put(mimeByExtension, "js", "text/javascript");
        put(mimeByExtension, "mjs", "text/javascript");
        put(mimeByExtension, "ts", "text/plain");
        put(mimeByExtension, "tsx", "text/plain");
        put(mimeByExtension, "jsx", "text/plain");
        put(mimeByExtension, "css", "text/css");
        put(mimeByExtension, "java", "text/plain");
        put(mimeByExtension, "py", "text/plain");
        put(mimeByExtension, "go", "text/plain");
        put(mimeByExtension, "rs", "text/plain");
        put(mimeByExtension, "c", "text/plain");
        put(mimeByExtension, "h", "text/plain");
        put(mimeByExtension, "cpp", "text/plain");
        put(mimeByExtension, "hpp", "text/plain");
        put(mimeByExtension, "cs", "text/plain");
        put(mimeByExtension, "php", "text/plain");
        put(mimeByExtension, "rb", "text/plain");
        put(mimeByExtension, "swift", "text/plain");
        put(mimeByExtension, "kt", "text/plain");
        put(mimeByExtension, "sh", "text/plain");
        put(mimeByExtension, "bat", "text/plain");
        put(mimeByExtension, "sql", "text/plain");
        put(mimeByExtension, "toml", "text/plain");
        put(mimeByExtension, "ini", "text/plain");
        put(mimeByExtension, "conf", "text/plain");
        MIME_BY_EXTENSION = Collections.unmodifiableMap(mimeByExtension);

        Map<String, String> extensionByMime = new HashMap<>();
        put(extensionByMime, "image/png", "png");
        put(extensionByMime, "image/jpeg", "jpg");
        put(extensionByMime, "image/gif", "gif");
        put(extensionByMime, "image/webp", "webp");
        put(extensionByMime, "image/bmp", "bmp");
        put(extensionByMime, "image/svg+xml", "svg");
        put(extensionByMime, "image/x-icon", "ico");
        put(extensionByMime, "image/tiff", "tiff");
        put(extensionByMime, "image/avif", "avif");
        put(extensionByMime, "application/pdf", "pdf");
        put(extensionByMime, "application/msword", "doc");
        put(extensionByMime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
        put(extensionByMime, "application/vnd.ms-excel", "xls");
        put(extensionByMime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx");
        put(extensionByMime, "application/vnd.ms-powerpoint", "ppt");
        put(extensionByMime, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx");
        put(extensionByMime, "text/plain", "txt");
        put(extensionByMime, "text/markdown", "md");
        put(extensionByMime, "text/csv", "csv");
        put(extensionByMime, "application/json", "json");
        put(extensionByMime, "application/xml", "xml");
        put(extensionByMime, "text/html", "html");
        put(extensionByMime, "application/yaml", "yaml");
        put(extensionByMime, "application/epub+zip", "epub");
        put(extensionByMime, "image/jpg", "jpg");
        put(extensionByMime, "text/x-markdown", "md");
        EXTENSION_BY_MIME = Collections.unmodifiableMap(extensionByMime);
    }

    private ShareIntakePolicy() {}

    private static void put(Map<String, String> target, String extension, String mime) {
        target.put(extension, mime);
    }

    static String extensionOf(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        return dot > 0 && dot < name.length() - 1
                ? name.substring(dot + 1).toLowerCase(Locale.ROOT)
                : "";
    }

    static String mimeForExtension(String extension) {
        return MIME_BY_EXTENSION.get(extension == null ? "" : extension.toLowerCase(Locale.ROOT));
    }

    static String mimeForName(String name) {
        return mimeForExtension(extensionOf(name));
    }

    static boolean isAllowedExtension(String extension) {
        return MIME_BY_EXTENSION.containsKey(
                extension == null ? "" : extension.toLowerCase(Locale.ROOT)
        );
    }

    static boolean exceedsFileCount(int count) {
        return count > MAX_FILES;
    }

    static boolean exceedsTextLength(int length) {
        return length > MAX_TEXT_CHARS;
    }

    static boolean exceedsFileSize(long bytes) {
        return bytes > MAX_FILE_BYTES;
    }

    static boolean exceedsTotalSize(long bytes) {
        return bytes > MAX_TOTAL_BYTES;
    }

    static String sanitizeDisplayName(String rawName, String mimeType) {
        String normalized = Normalizer.normalize(rawName == null ? "" : rawName, Normalizer.Form.NFC);
        int separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
        String base = normalized.substring(separator + 1);

        StringBuilder safe = new StringBuilder(base.length());
        for (int index = 0; index < base.length(); index++) {
            char value = base.charAt(index);
            if (Character.isISOControl(value) || value == '/' || value == '\\' || value == ':'
                    || value == '*' || value == '?' || value == '"' || value == '<'
                    || value == '>' || value == '|' || value == '#' || value == '%') {
                safe.append('_');
            } else {
                safe.append(value);
            }
        }

        int start = 0;
        int end = safe.length();
        while (start < end && isTrimmedNameCharacter(safe.charAt(start))) start++;
        while (end > start && isTrimmedNameCharacter(safe.charAt(end - 1))) end--;
        String name = safe.substring(start, end);
        if (name.isEmpty()) name = "shared-file";

        String extension = extensionOf(name);
        if (extension.isEmpty()) {
            String fromMime = EXTENSION_BY_MIME.get(normalizeMime(mimeType));
            if (fromMime != null) {
                name = name + "." + fromMime;
                extension = fromMime;
            }
        }

        if (extension.isEmpty()) {
            return truncateStem(name, "");
        }
        int dot = name.lastIndexOf('.');
        return truncateStem(name.substring(0, dot), extension) + "." + extension;
    }

    private static boolean isTrimmedNameCharacter(char value) {
        return Character.isWhitespace(value) || value == '.' || value == '_';
    }

    private static String truncateStem(String stem, String extension) {
        String base = stem.isEmpty() ? "shared-file" : stem;
        int reserved = extension.isEmpty() ? 0 : extension.length() + 1;
        int limit = Math.max(1, MAX_NAME_CHARS - reserved);
        if (base.length() <= limit) return base;
        int end = limit;
        if (Character.isHighSurrogate(base.charAt(end - 1))) end--;
        return base.substring(0, Math.max(1, end));
    }

    static String normalizeMime(String mimeType) {
        if (mimeType == null) return "";
        int parameters = mimeType.indexOf(';');
        String value = parameters >= 0 ? mimeType.substring(0, parameters) : mimeType;
        return value.trim().toLowerCase(Locale.ROOT);
    }

    static boolean isValidUriScheme(String scheme) {
        return "content".equalsIgnoreCase(scheme);
    }

    static String shortcutActionFor(
            String scheme,
            String host,
            String type,
            String packageName
    ) {
        if (!"action".equals(host) || scheme == null) return null;
        if (!"app.deepchat.mobile".equalsIgnoreCase(scheme)
                && !"deepchat".equalsIgnoreCase(scheme)
                && !"deepchat.mobile".equalsIgnoreCase(scheme)
                && !scheme.equalsIgnoreCase(packageName)) {
            return null;
        }
        if ("new".equals(type) || "voice".equals(type) || "camera".equals(type)) {
            return type;
        }
        return null;
    }

    static boolean isWithinDirectory(File directory, File candidate) {
        try {
            String parent = directory.getCanonicalPath();
            String child = candidate.getCanonicalPath();
            return child.equals(parent) || child.startsWith(parent + File.separator);
        } catch (IOException ignored) {
            return false;
        }
    }
}
