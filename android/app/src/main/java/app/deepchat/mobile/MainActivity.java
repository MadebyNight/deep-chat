package app.deepchat.mobile;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureCredentialsPlugin.class);
        super.onCreate(savedInstanceState);
        // 设备系统字体缩放（例如 1.15）会同比放大 WebView 内文字，导致与官方 App 的观感不一致。
        // 官方为原生渲染不受影响，这里固定文字缩放为 100%，布局尺寸仍按 CSS 像素精确控制。
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setTextZoom(100);
    }
}
