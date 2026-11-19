package app.deepchat.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureCredentialsPlugin.class);
        registerPlugin(OfficialBrowserPlugin.class);
        registerPlugin(DeepSeekAccountPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
