package app.deepchat.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.Proxy;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLException;

import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.Dns;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 第三方 MCP / 联网搜索的受控 HTTPS 请求代理。
 * 只允许配置的 HTTPS 地址；禁止重定向、Cookie、危险请求头和疑似放在 URL 查询串里的密钥。
 */
@CapacitorPlugin(name = "ExternalHttp")
public final class ExternalHttpPlugin extends Plugin {
    private static final class ResponseTooLargeException extends IOException {}

    private static final int MAX_REQUEST_BYTES = 256 * 1024;
    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    private static final int MAX_HEADER_BYTES = 8192;
    private static final Set<String> METHODS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList("GET", "POST")));
    private static final Set<String> ALLOWED_HEADERS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "accept", "content-type", "authorization", "mcp-session-id",
                    "mcp-protocol-version", "last-event-id", "cache-control",
                    "x-api-key", "x-subscription-token")));
    private static final Set<String> SECRET_QUERY_KEYS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "api_key", "apikey", "key", "token", "access_token",
                    "secret", "password", "authorization")));
    private static final Set<String> RESPONSE_HEADERS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "content-type", "mcp-session-id", "retry-after", "www-authenticate")));
    private static final Set<String> METADATA_HOSTS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "169.254.169.254", "100.100.100.200", "metadata.google.internal",
                    "::ffff:a9fe:a9fe", "fd00:ec2::254")));

    private final OkHttpClient http = new OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES)
            .proxy(Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .dns(hostname -> {
                List<InetAddress> addresses = Dns.SYSTEM.lookup(hostname);
                for (InetAddress address : addresses) {
                    if (isBlockedAddress(address)) {
                        throw new UnknownHostException("Blocked address");
                    }
                }
                return addresses;
            })
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private final ConcurrentHashMap<String, Call> active = new ConcurrentHashMap<>();
    private final Set<String> activeIds = ConcurrentHashMap.newKeySet();
    private final Set<String> cancelledIds = ConcurrentHashMap.newKeySet();

    @Override
    protected void handleOnDestroy() {
        active.values().forEach(Call::cancel);
        executor.shutdownNow();
    }

    @PluginMethod
    public void request(PluginCall call) {
        String id = call.getString("id", "");
        if (!validId(id)) {
            call.reject("Invalid request ID", "INVALID_REQUEST");
            return;
        }
        String method = call.getString("method", "").toUpperCase(Locale.ROOT);
        if (!METHODS.contains(method)) {
            call.reject("Unsupported method", "INVALID_REQUEST");
            return;
        }
        URI target;
        try {
            target = validateUrl(call.getString("url", ""));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid URL", "INVALID_URL");
            return;
        }
        Headers headers;
        try {
            headers = readHeaders(call.getObject("headers"));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid headers", "INVALID_REQUEST");
            return;
        }
        String bodyText = call.getString("body");
        if (bodyText != null && bodyText.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_BYTES) {
            call.reject("Request is too large", "REQUEST_TOO_LARGE");
            return;
        }
        int timeoutMs = Math.max(5000, Math.min(60_000, call.getInt("timeoutMs", 30_000)));
        if (!activeIds.add(id)) {
            call.reject("Duplicate request", "INVALID_REQUEST");
            return;
        }
        executor.execute(() -> execute(call, id, method, target, headers, bodyText, timeoutMs));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        if (!activeIds.contains(id)) {
            call.resolve();
            return;
        }
        cancelledIds.add(id);
        Call request = active.get(id);
        if (request != null) {
            request.cancel();
        }
        call.resolve();
    }

    private void execute(
            PluginCall call,
            String id,
            String method,
            URI target,
            Headers headers,
            String bodyText,
            int timeoutMs) {
        Call request = null;
        if (cancelledIds.remove(id)) {
            activeIds.remove(id);
            call.reject("Request cancelled", "CANCELLED");
            return;
        }
        try {
            Request.Builder builder = new Request.Builder()
                    .url(target.toASCIIString())
                    .headers(headers);
            if ("POST".equals(method)) {
                MediaType type = MediaType.parse(
                        headers.get("Content-Type") == null
                                ? "application/json; charset=utf-8"
                                : headers.get("Content-Type"));
                RequestBody body = RequestBody.create(bodyText == null ? "" : bodyText, type);
                builder.method(method, body);
            } else {
                builder.method(method, null);
            }
            request = http.newBuilder()
                    .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build()
                    .newCall(builder.build());
            active.put(id, request);
            try (Response response = request.execute()) {
                int status = response.code();
                if (status >= 300 && status < 400) {
                    call.reject("Redirects are not allowed", "REDIRECT_BLOCKED");
                    return;
                }
                ResponseBody responseBody = response.body();
                String text = "";
                if (responseBody != null) {
                    long length = responseBody.contentLength();
                    if (length > MAX_RESPONSE_BYTES) {
                        call.reject("Response is too large", "RESPONSE_TOO_LARGE");
                        return;
                    }
                    text = readBody(responseBody);
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", text);
                JSObject responseHeaders = new JSObject();
                for (String name : response.headers().names()) {
                    if (RESPONSE_HEADERS.contains(name.toLowerCase(Locale.ROOT))) {
                        responseHeaders.put(name, response.headers().get(name));
                    }
                }
                result.put("headers", responseHeaders);
                call.resolve(result);
            }
        } catch (SocketTimeoutException error) {
            call.reject("Request timed out", "TIMEOUT");
        } catch (InterruptedIOException error) {
            call.reject(
                    request != null && request.isCanceled() ? "Request cancelled" : "Request timed out",
                    request != null && request.isCanceled() ? "CANCELLED" : "TIMEOUT");
        } catch (SSLException error) {
            call.reject("TLS check failed", "TLS");
        } catch (UnknownHostException | ConnectException error) {
            call.reject("Network is unavailable", "NETWORK");
        } catch (ResponseTooLargeException error) {
            call.reject("Response is too large", "RESPONSE_TOO_LARGE");
        } catch (IOException error) {
            call.reject(
                    request != null && request.isCanceled() ? "Request cancelled" : "Network is unavailable",
                    request != null && request.isCanceled() ? "CANCELLED" : "NETWORK");
        } catch (IllegalArgumentException error) {
            call.reject("Invalid request", "INVALID_REQUEST");
        } catch (Exception error) {
            call.reject("Request failed", "NETWORK");
        } finally {
            active.remove(id);
            activeIds.remove(id);
            cancelledIds.remove(id);
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
                    throw new ResponseTooLargeException();
                }
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static URI validateUrl(String value) {
        if (value == null || value.isEmpty() || value.length() > 4096) {
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
                uri.getRawUserInfo() != null || uri.getRawFragment() != null ||
                hasSecretQuery(uri.getRawQuery())) {
            throw new IllegalArgumentException();
        }
        if (isMetadataHost(host)) {
            throw new IllegalArgumentException();
        }
        String literal = host.replace("[", "").replace("]", "");
        if (isLiteralHost(literal)) {
            try {
                if (isBlockedAddress(InetAddress.getByName(literal))) {
                    throw new IllegalArgumentException();
                }
            } catch (UnknownHostException error) {
                throw new IllegalArgumentException();
            }
        }
        return uri;
    }

    private static boolean hasSecretQuery(String query) {
        if (query == null || query.isEmpty()) {
            return false;
        }
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            String name = equals < 0 ? pair : pair.substring(0, equals);
            try {
                name = java.net.URLDecoder.decode(name, StandardCharsets.UTF_8.name())
                        .toLowerCase(Locale.ROOT);
            } catch (Exception ignored) {
                name = name.toLowerCase(Locale.ROOT);
            }
            if (SECRET_QUERY_KEYS.contains(name)) {
                return true;
            }
        }
        return false;
    }

    private static Headers readHeaders(JSObject source) {
        Headers.Builder headers = new Headers.Builder();
        if (source == null) {
            return headers.build();
        }
        Iterator<String> names = source.keys();
        int count = 0;
        int totalBytes = 0;
        while (names.hasNext()) {
            String name = names.next();
            String lower = name.toLowerCase(Locale.ROOT);
            String value = source.optString(name, null);
            if (value == null) {
                continue;
            }
            totalBytes += value.getBytes(StandardCharsets.UTF_8).length;
            if (++count > 16 || value.length() > MAX_HEADER_BYTES || totalBytes > 24 * 1024 ||
                    !ALLOWED_HEADERS.contains(lower) ||
                    !name.matches("[A-Za-z0-9-]+") ||
                    value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
                throw new IllegalArgumentException();
            }
            headers.add(name, value);
        }
        return headers.build();
    }

    private static boolean validId(String id) {
        return id != null && id.matches("[A-Za-z0-9-]{8,80}");
    }

    private static boolean isMetadataHost(String host) {
        String value = host.toLowerCase(Locale.ROOT).replace("[", "").replace("]", "");
        return METADATA_HOSTS.contains(value) ||
                "localhost".equals(value) ||
                value.endsWith(".localhost");
    }

    private static boolean isLiteralHost(String host) {
        return host.indexOf(':') >= 0 ||
                host.matches("[0-9.]+") ||
                host.matches("(?i)0x[0-9a-f]+") ||
                host.matches("(?i)[0-9a-f]+");
    }

    private static boolean isBlockedAddress(InetAddress address) {
        if (address.isLinkLocalAddress() || address.isAnyLocalAddress() ||
                address.isLoopbackAddress() || address.isSiteLocalAddress() ||
                address.isMulticastAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            int first = bytes[0] & 0xff;
            int second = bytes[1] & 0xff;
            return first == 0 ||
                    first == 10 ||
                    first == 127 ||
                    (first == 100 && second >= 64 && second <= 127) ||
                    (first == 169 && second == 254) ||
                    (first == 172 && second >= 16 && second <= 31) ||
                    (first == 192 && second == 0) ||
                    (first == 192 && second == 168) ||
                    (first == 198 && (second == 18 || second == 19)) ||
                    (first == 198 && second == 51) ||
                    (first == 203 && second == 0) ||
                    first >= 224;
        }
        String host = address.getHostAddress().toLowerCase(Locale.ROOT);
        int zone = host.indexOf('%');
        if (zone >= 0) {
            host = host.substring(0, zone);
        }
        return "100.100.100.200".equals(host) ||
                "fd00:ec2::254".equals(host) ||
                host.startsWith("::ffff:") ||
                host.startsWith("fc") ||
                host.startsWith("fd") ||
                host.startsWith("fec") ||
                host.startsWith("ff");
    }
}
