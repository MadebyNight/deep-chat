package app.deepchat.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsClient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OfficialBrowser")
public class OfficialBrowserPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        Uri page = Uri.parse(url == null ? "" : url);
        if (!"https".equals(page.getScheme()) || !"platform.deepseek.com".equals(page.getAuthority())) {
            call.reject("Not a DeepSeek Open Platform URL");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                MainActivity activity = (MainActivity) getActivity();
                if ("/dsh/authorize".equals(page.getPath())) {
                    String provider = CustomTabsClient.getPackageName(activity, java.util.List.of("com.android.chrome"));
                    if (provider != null) {
                        activity.openAccountAuthorization(page, provider);
                        call.resolve();
                        return;
                    }
                }
                activity.startActivity(new Intent(Intent.ACTION_VIEW, page).addCategory(Intent.CATEGORY_BROWSABLE));
                call.resolve();
            } catch (ActivityNotFoundException | SecurityException exception) {
                call.reject("Could not open the official page", exception);
            }
        });
    }
}
