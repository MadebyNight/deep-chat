package app.deepchat.mobile;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.TextView;

import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.browser.auth.AuthTabIntent;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private View recoveryPanel;
    private Boolean barDark;
    private Integer barBackground;
    private float safeTopDp;
    private float safeRightDp;
    private float safeBottomDp;
    private float safeLeftDp;
    private final ActivityResultLauncher<Intent> accountAuthorization =
            AuthTabIntent.registerActivityResultLauncher(this, result -> {
                // The loopback callback has already validated authorization and stored credentials.
                // The browser result only closes its tab. The WebView polls the account state.
            });

    void openAccountAuthorization(Uri page, String provider) {
        AuthTabIntent tab = new AuthTabIntent.Builder().build();
        tab.intent.setPackage(provider);
        tab.launch(accountAuthorization, page, getPackageName());
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StartupRecoveryPlugin.class);
        registerPlugin(SecureCredentialsPlugin.class);
        registerPlugin(OfficialBrowserPlugin.class);
        registerPlugin(DeepSeekAccountPlugin.class);
        registerPlugin(HistoryExportDownloadPlugin.class);
        registerPlugin(UpdateInstallerPlugin.class);
        super.onCreate(savedInstanceState);
        setupEdgeToEdge();
    }

    private void setupEdgeToEdge() {
        EdgeToEdge.enable(
                this,
                SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
                SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT)
        );
        getWindow().getDecorView().setPadding(0, 0, 0, 0);
        View content = findViewById(android.R.id.content);
        if (content == null) return;
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            Insets system = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            int bottomPadding = imeVisible ? ime.bottom : 0;
            if (view.getPaddingLeft() != 0 || view.getPaddingTop() != 0
                    || view.getPaddingRight() != 0 || view.getPaddingBottom() != bottomPadding) {
                view.setPadding(0, 0, 0, bottomPadding);
            }
            float density = getResources().getDisplayMetrics().density;
            if (density <= 0f) density = 1f;
            int remainingBottom = imeVisible ? Math.max(0, system.bottom - ime.bottom) : system.bottom;
            safeTopDp = system.top / density;
            safeRightDp = system.right / density;
            safeBottomDp = remainingBottom / density;
            safeLeftDp = system.left / density;
            applyCssSafeArea(bridge != null ? bridge.getWebView() : null);
            return new WindowInsetsCompat.Builder(insets)
                    .setInsets(
                            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                            Insets.NONE
                    )
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                    .setVisible(WindowInsetsCompat.Type.ime(), false)
                    .build();
        });
        ViewCompat.requestApplyInsets(content);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBarAppearance();
        View content = findViewById(android.R.id.content);
        if (content != null) ViewCompat.requestApplyInsets(content);
    }

    void setSystemBarAppearance(boolean dark, Integer background) {
        barDark = dark;
        if (background != null) barBackground = background;
        applySystemBarAppearance();
    }

    private void applySystemBarAppearance() {
        var window = getWindow();
        if (barDark != null) {
            WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!barDark);
            controller.setAppearanceLightNavigationBars(!barDark);
        }
        if (barBackground != null) {
            window.getDecorView().setBackgroundColor(barBackground);
        }
    }

    void applyCssSafeArea(WebView webView) {
        if (webView == null) return;
        String js = String.format(
                Locale.US,
                "try{var s=document.documentElement.style;"
                        + "s.setProperty('--safe-area-top','%.2fpx');"
                        + "s.setProperty('--safe-area-right','%.2fpx');"
                        + "s.setProperty('--safe-area-bottom','%.2fpx');"
                        + "s.setProperty('--safe-area-left','%.2fpx');"
                        + "}catch(e){}",
                safeTopDp, safeRightDp, safeBottomDp, safeLeftDp
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void showRecovery(WebView webView, String diagnostic) {
        if (recoveryPanel != null || isFinishing() || isDestroyed()) return;
        ViewGroup parent = (ViewGroup) webView.getParent();
        recoveryPanel = getLayoutInflater().inflate(R.layout.startup_recovery, parent, false);
        TextView details = recoveryPanel.findViewById(R.id.startup_recovery_diagnostic);
        details.setText(diagnostic);
        recoveryPanel.findViewById(R.id.startup_recovery_retry).setOnClickListener(button -> {
            button.setEnabled(false);
            recreate();
        });
        if (parent == null) {
            setContentView(recoveryPanel);
        } else {
            parent.addView(recoveryPanel);
        }
        webView.setVisibility(View.GONE);
    }

    @CapacitorPlugin(name = "StartupRecovery")
    public static final class StartupRecoveryPlugin extends Plugin {
        @Override
        public void load() {
            Bridge bridge = getBridge();
            bridge.setWebViewClient(new RecoveryClient((MainActivity) getActivity(), bridge));
        }

        @PluginMethod
        public void setSystemBarAppearance(PluginCall call) {
            boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
            String colorValue = call.getString("background");
            Integer parsed = null;
            if (colorValue != null) {
                try {
                    parsed = Color.parseColor(colorValue);
                } catch (IllegalArgumentException ignored) {
                    // Ignore malformed colors.
                }
            }
            Integer background = parsed;
            MainActivity activity = (MainActivity) getActivity();
            activity.runOnUiThread(() -> {
                activity.setSystemBarAppearance(dark, background);
                call.resolve();
            });
        }
    }

    private static final class RecoveryClient extends BridgeWebViewClient {
        private final MainActivity activity;
        private final Bridge bridge;
        private boolean fallbackRequested;
        private boolean rendererRetired;
        private String mainDocumentError;

        RecoveryClient(MainActivity activity, Bridge bridge) {
            super(bridge);
            this.activity = activity;
            this.bridge = bridge;
        }

        private boolean handleFailure(WebView view, WebResourceRequest request, String error) {
            if (rendererRetired || activity.recoveryPanel != null) return true;
            if (!request.isForMainFrame()) return false;
            String errorUrl = bridge.getErrorUrl();
            if (errorUrl == null) {
                activity.showRecovery(view, "MAIN_DOCUMENT · " + error);
                return true;
            }
            if (errorUrl.equals(request.getUrl().toString())) {
                String fallbackError = "FALLBACK_DOCUMENT · " + error;
                activity.showRecovery(view, mainDocumentError == null
                        ? fallbackError : mainDocumentError + "\n" + fallbackError);
                return true;
            }
            if (fallbackRequested) return true;
            fallbackRequested = true;
            mainDocumentError = "MAIN_DOCUMENT · " + error;
            return false;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!handleFailure(view, request, "WEBVIEW_ERROR " + error.getErrorCode())) {
                super.onReceivedError(view, request, error);
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
            if (!handleFailure(view, request, "HTTP " + error.getStatusCode())) {
                super.onReceivedHttpError(view, request, error);
            }
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            fallbackRequested = false;
            if (!url.equals(bridge.getErrorUrl())) mainDocumentError = null;
            activity.applyCssSafeArea(view);
            super.onPageCommitVisible(view, url);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (rendererRetired) return true;
            rendererRetired = true;
            activity.showRecovery(view, detail.didCrash() ? "WEBVIEW_RENDERER_CRASH" : "WEBVIEW_RENDERER_TERMINATED");
            // The base activity must not dispatch lifecycle calls to the retired Bridge again.
            activity.bridge = null;
            if (view.getParent() instanceof ViewGroup parent) parent.removeView(view);
            try {
                bridge.onDestroy();
            } finally {
                bridge.onDetachedFromWindow();
            }
            return true;
        }
    }
}
