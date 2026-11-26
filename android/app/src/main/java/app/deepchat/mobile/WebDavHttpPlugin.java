package app.deepchat.mobile;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLException;

import okhttp3.Dns;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 受控 WebDAV 请求代理：只接受用户配置的 HTTPS 目录，禁止重定向、
 * 禁止跨源路径和危险请求头，避免 WebView CORS 与 SSRF/凭据跳转风险。
 */
@CapacitorPlugin(name = "WebDavHttp")
public final class WebDavHttpPlugin extends Plugin {
    private static final int MAX_REQUEST_BYTES = 24 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
    private static final Set<String> METHODS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList("PROPFIND", "MKCOL", "GET", "PUT", "DELETE")));
    private static final Set<String> ALLOWED_HEADERS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "accept", "authorization", "content-type", "depth",
                    "if-match", "if-none-match")));
    private static final Set<String> METADATA_HOSTS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "169.254.169.254", "100.100.100.200", "metadata.google.internal",
                    "::ffff:a9fe:a9fe", "fd00:ec2::254")));

    private final OkHttpClient http = new OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .dns(hostname -> {
                List<InetAddress> addresses = Dns.SYSTEM.lookup(hostname);
                for (InetAddress address : addresses) {
                    if (isBlockedAddress(address)) {
                        throw new UnknownHostException("Blocked metadata address");
                    }
                }
                return addresses;
            })
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS)
            .writeTimeout(45, TimeUnit.SECONDS)
            .build();
    private final ExecutorService executor = Executors.newFixedThreadPool(3);

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
    }

    @PluginMethod
    public void request(PluginCall call) {
        String method = call.getString("method", "").toUpperCase(Locale.ROOT);
        if (!METHODS.contains(method)) {
            call.reject("Unsupported WebDAV method", "METHOD_NOT_ALLOWED");
            return;
        }
        URI base;
        URI target;
        try {
            base = validateBase(call.getString("baseUrl", ""));
            String configuredHash = getContext()
                    .getSharedPreferences("secure_webdav", Context.MODE_PRIVATE)
                    .getString("configuredUrlHash", null);
            if (configuredHash == null ||
                    !configuredHash.equals(SecureCredentialsPlugin.webDavUrlHash(base.toASCIIString()))) {
                throw new IllegalArgumentException();
            }
            target = resolveTarget(base, call.getString("path", ""));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid WebDAV URL", "INVALID_URL");
            return;
        } catch (Exception error) {
            call.reject("Invalid WebDAV URL", "INVALID_URL");
            return;
        }
        Headers headers;
        try {
            headers = readHeaders(call.getObject("headers"));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid WebDAV headers", "INVALID_URL");
            return;
        }
        String bodyText = call.getString("body", "");
        if (bodyText != null && bodyText.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_BYTES) {
            call.reject("WebDAV request is too large", "REQUEST_TOO_LARGE");
            return;
        }
        int timeoutMs = Math.max(5000, Math.min(120_000, call.getInt("timeoutMs", 30_000)));
        executor.execute(() -> execute(call, method, target, headers, bodyText, timeoutMs));
    }

    private void execute(
            PluginCall call,
            String method,
            URI target,
            Headers headers,
            String bodyText,
            int timeoutMs) {
        try {
            Request.Builder builder = new Request.Builder()
                    .url(target.toASCIIString())
                    .headers(headers);
            if ("PUT".equals(method) || "PROPFIND".equals(method)) {
                MediaType type = MediaType.parse(
                        headers.get("Content-Type") == null
                                ? "application/json; charset=utf-8"
                                : headers.get("Content-Type"));
                RequestBody body = RequestBody.create(
                        bodyText == null ? "" : bodyText,
                        type);
                builder.method(method, body);
            } else {
                builder.method(method, null);
            }
            okhttp3.Call callHandle = http.newBuilder()
                    .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build()
                    .newCall(builder.build());
            try (Response response = callHandle.execute()) {
                int status = response.code();
                if (status >= 300 && status < 400) {
                    call.reject("WebDAV redirects are not allowed", "REDIRECT_BLOCKED");
                    return;
                }
                ResponseBody responseBody = response.body();
                String text = "";
                if (responseBody != null) {
                    long length = responseBody.contentLength();
                    if (length > MAX_RESPONSE_BYTES) {
                        call.reject("WebDAV response is too large", "RESPONSE_TOO_LARGE");
                        return;
                    }
                    text = readBody(responseBody);
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", text);
                JSObject responseHeaders = new JSObject();
                for (String name : response.headers().names()) {
                    responseHeaders.put(name, response.headers().get(name));
                }
                result.put("headers", responseHeaders);
                call.resolve(result);
            }
        } catch (SocketTimeoutException error) {
            call.reject("WebDAV request timed out", "TIMEOUT");
        } catch (SSLException error) {
            call.reject("WebDAV TLS check failed", "TLS");
        } catch (UnknownHostException | ConnectException error) {
            call.reject("WebDAV network is unavailable", "NETWORK");
        } catch (IOException error) {
            call.reject("WebDAV network is unavailable", "NETWORK");
        } catch (IllegalArgumentException error) {
            call.reject("Invalid WebDAV request", "INVALID_URL");
        } catch (Exception error) {
            call.reject("WebDAV request failed", "NETWORK");
        }
    }

    private static String readBody(ResponseBody body) throws IOException {
        try (InputStream input = body.byteStream();
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            int total = 0;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) {
                    throw new IOException("Response too large");
                }
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static URI validateBase(String value) {
        if (value == null || value.isEmpty() || value.length() > 2048 ||
                value.indexOf('\\') >= 0) {
            throw new IllegalArgumentException();
        }
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException();
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(scheme) || host == null || host.isEmpty() ||
                uri.getRawUserInfo() != null || uri.getRawQuery() != null ||
                uri.getRawFragment() != null) {
            throw new IllegalArgumentException();
        }
        String lowerHost = host.toLowerCase(Locale.ROOT);
        if (isMetadataHost(lowerHost)) {
            throw new IllegalArgumentException();
        }
        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) {
            path = "/";
        }
        if (!path.endsWith("/")) {
            path += "/";
        }
        if (unsafePath(path)) {
            throw new IllegalArgumentException();
        }
        return URI.create(uri.getScheme() + "://" + uri.getRawAuthority() + path);
    }

    private static URI resolveTarget(URI base, String path) {
        if (path == null) {
            path = "";
        }
        String lower = path.toLowerCase(Locale.ROOT);
        if (path.length() > 2048 || path.startsWith("/") || path.contains("\\") ||
                path.contains("?") || path.contains("#") || path.contains("//") ||
                lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") ||
                lower.contains("%25") || lower.contains("%00") ||
                lower.contains("%0d") || lower.contains("%0a") ||
                path.startsWith("..") || path.endsWith("..") || lower.contains("/../") ||
                lower.contains("/./") || ".".equals(path) || "..".equals(path)) {
            throw new IllegalArgumentException();
        }
        URI target = URI.create(base.toASCIIString() + path).normalize();
        if (!"https".equalsIgnoreCase(target.getScheme()) ||
                target.getHost() == null ||
                !target.getHost().equalsIgnoreCase(base.getHost()) ||
                target.getPort() != base.getPort() ||
                target.getRawQuery() != null ||
                target.getRawFragment() != null ||
                target.getRawPath() == null ||
                !target.getRawPath().startsWith(base.getRawPath())) {
            throw new IllegalArgumentException();
        }
        return target;
    }

    private static Headers readHeaders(JSObject source) {
        Headers.Builder headers = new Headers.Builder();
        if (source == null) {
            return headers.build();
        }
        Iterator<String> names = source.keys();
        int count = 0;
        while (names.hasNext()) {
            String name = names.next();
            String lower = name.toLowerCase(Locale.ROOT);
            String value = source.optString(name, null);
            if (++count > 16 || value == null || value.length() > 8192 ||
                    !ALLOWED_HEADERS.contains(lower) ||
                    !name.matches("[A-Za-z0-9-]+") ||
                    value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
                throw new IllegalArgumentException();
            }
            headers.add(name, value);
        }
        return headers.build();
    }

    private static boolean unsafePath(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        for (String segment : path.split("/", -1)) {
            if (".".equals(segment) || "..".equals(segment)) {
                return true;
            }
        }
        return path.contains("\\") || path.contains("//") ||
                lower.contains("%2e") || lower.contains("%2f") ||
                lower.contains("%5c") || lower.contains("%25") ||
                lower.contains("%00") ||
                lower.contains("%0d") || lower.contains("%0a");
    }

    private static boolean isMetadataHost(String host) {
        return METADATA_HOSTS.contains(host.replace("[", "").replace("]", ""));
    }

    private static boolean isBlockedAddress(InetAddress address) {
        if (address.isLinkLocalAddress()) {
            return true;
        }
        String host = address.getHostAddress().toLowerCase(Locale.ROOT);
        int zone = host.indexOf('%');
        if (zone >= 0) {
            host = host.substring(0, zone);
        }
        return "100.100.100.200".equals(host) ||
                "fd00:ec2::254".equals(host) ||
                "::ffff:169.254.169.254".equals(host) ||
                "::ffff:a9fe:a9fe".equals(host);
    }
}
