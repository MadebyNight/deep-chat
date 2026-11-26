package app.deepchat.mobile;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;

import androidx.core.content.ContextCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AppIdentity")
public final class AppIdentityPlugin extends Plugin {
    private static final String EVENT_SHORTCUT_PINNED = "shortcutPinned";
    private static final String PIN_ACTION_SUFFIX = ".SHORTCUT_PINNED";
    private BroadcastReceiver pinReceiver;
    private String pinAction;

    @Override
    public void load() {
        pinAction = getContext().getPackageName() + PIN_ACTION_SUFFIX;
        pinReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null || !pinAction.equals(intent.getAction())) return;
                String id = intent.getStringExtra("id");
                String type = intent.getStringExtra("type");
                String icon = intent.getStringExtra("icon");
                if (id == null || id.isEmpty()
                        || !AppIdentityPolicy.isAllowedShortcutType(type)
                        || !AppIdentityPolicy.isAllowedIcon(icon)) {
                    return;
                }
                JSObject payload = new JSObject();
                payload.put("id", id);
                payload.put("type", type);
                payload.put("icon", icon);
                notifyListeners(EVENT_SHORTCUT_PINNED, payload);
            }
        };
        try {
            ContextCompat.registerReceiver(
                    getContext(),
                    pinReceiver,
                    new IntentFilter(pinAction),
                    ContextCompat.RECEIVER_NOT_EXPORTED
            );
        } catch (Exception ignored) {
            // Shortcut requests still work; only the confirmation event is unavailable.
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (pinReceiver != null) {
            try {
                getContext().unregisterReceiver(pinReceiver);
            } catch (IllegalArgumentException ignored) {
                // Already unregistered with the activity.
            }
            pinReceiver = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("currentIcon", currentLauncherIcon());
        boolean requestPinShortcut = false;
        try {
            requestPinShortcut = ShortcutManagerCompat.isRequestPinShortcutSupported(getContext());
        } catch (Exception ignored) {
            // Older launchers may not expose shortcut pinning.
        }
        result.put("requestPinShortcut", requestPinShortcut);
        call.resolve(result);
    }

    @PluginMethod
    public void setLauncherIcon(PluginCall call) {
        String icon = call.getString("icon");
        if (!AppIdentityPolicy.isAllowedIcon(icon)) {
            call.reject("Unknown launcher icon", "INVALID_ICON");
            return;
        }
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Activity unavailable", "UNAVAILABLE");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                PackageManager manager = getContext().getPackageManager();
                String packageName = getContext().getPackageName();
                ComponentName target = new ComponentName(
                        packageName,
                        AppIdentityPolicy.aliasComponentName(packageName, icon)
                );
                manager.setComponentEnabledSetting(
                        target,
                        PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                        PackageManager.DONT_KILL_APP
                );
                for (String candidate : AppIdentityPolicy.LAUNCHER_ICONS) {
                    if (candidate.equals(icon)) continue;
                    ComponentName alias = new ComponentName(
                            packageName,
                            AppIdentityPolicy.aliasComponentName(packageName, candidate)
                    );
                    manager.setComponentEnabledSetting(
                            alias,
                            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                            PackageManager.DONT_KILL_APP
                    );
                }
                call.resolve(new JSObject().put("icon", icon));
            } catch (Exception error) {
                call.reject("Could not switch the launcher icon", "LAUNCHER_ICON_FAILED");
            }
        });
    }

    @PluginMethod
    public void createShortcut(PluginCall call) {
        String type = call.getString("type", "new");
        String icon = call.getString("icon", AppIdentityPolicy.DEFAULT_ICON);
        if (!AppIdentityPolicy.isAllowedShortcutType(type)) {
            call.reject("Unknown shortcut action", "INVALID_TYPE");
            return;
        }
        if (!AppIdentityPolicy.isAllowedIcon(icon)) {
            call.reject("Unknown shortcut icon", "INVALID_ICON");
            return;
        }
        String id = AppIdentityPolicy.shortcutId(type, icon);
        if (id == null) {
            call.reject("Invalid shortcut", "INVALID_SHORTCUT");
            return;
        }
        String label = AppIdentityPolicy.sanitizeShortcutLabel(
                call.getString("label"),
                getContext().getString(R.string.app_name)
        );
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Activity unavailable", "UNAVAILABLE");
            return;
        }
        activity.runOnUiThread(() -> {
            Context context = getContext();
            if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
                call.reject("Launcher does not support pinned shortcuts", "UNSUPPORTED");
                return;
            }
            try {
                for (ShortcutInfoCompat existing : ShortcutManagerCompat.getShortcuts(
                        context,
                        ShortcutManagerCompat.FLAG_MATCH_PINNED
                )) {
                    if (id.equals(existing.getId())) {
                        call.reject("Shortcut already pinned", "ALREADY_PINNED");
                        return;
                    }
                }
                String data = AppIdentityPolicy.shortcutData(context.getPackageName(), type);
                if (data == null) {
                    call.reject("Invalid shortcut route", "INVALID_SHORTCUT");
                    return;
                }
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(data));
                intent.setClass(context, MainActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(context, id)
                        .setShortLabel(label)
                        .setLongLabel(label)
                        .setIcon(IconCompat.createWithResource(context, shortcutIconResource(icon)))
                        .setIntent(intent)
                        .build();
                PendingIntent callback = PendingIntent.getBroadcast(
                        context,
                        id.hashCode(),
                        new Intent(pinAction)
                                .setPackage(context.getPackageName())
                                .putExtra("id", id)
                                .putExtra("type", type)
                                .putExtra("icon", icon),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                boolean requested = ShortcutManagerCompat.requestPinShortcut(
                        context,
                        shortcut,
                        callback.getIntentSender()
                );
                if (!requested) {
                    call.reject("Could not request a shortcut", "SHORTCUT_FAILED");
                    return;
                }
                call.resolve(new JSObject().put("requested", true).put("id", id));
            } catch (Exception error) {
                call.reject("Could not create the shortcut", "SHORTCUT_FAILED");
            }
        });
    }

    private String currentLauncherIcon() {
        PackageManager manager = getContext().getPackageManager();
        String packageName = getContext().getPackageName();
        for (String icon : AppIdentityPolicy.LAUNCHER_ICONS) {
            ComponentName alias = new ComponentName(
                    packageName,
                    AppIdentityPolicy.aliasComponentName(packageName, icon)
            );
            if (manager.getComponentEnabledSetting(alias)
                    == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
                return icon;
            }
        }
        return AppIdentityPolicy.DEFAULT_ICON;
    }

    private static int shortcutIconResource(String icon) {
        if ("ocean".equals(icon)) return R.drawable.ic_shortcut_theme_ocean;
        if ("forest".equals(icon)) return R.drawable.ic_shortcut_theme_forest;
        if ("sunset".equals(icon)) return R.drawable.ic_shortcut_theme_sunset;
        return R.drawable.ic_shortcut_theme_default;
    }
}
