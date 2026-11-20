package app.deepchat.mobile;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.TextView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

public class MainActivity extends BridgeActivity {
    private View recoveryPanel;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StartupRecoveryPlugin.class);
        registerPlugin(SecureCredentialsPlugin.class);
        registerPlugin(OfficialBrowserPlugin.class);
        registerPlugin(DeepSeekAccountPlugin.class);
        registerPlugin(HistoryExportDownloadPlugin.class);
        super.onCreate(savedInstanceState);
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
