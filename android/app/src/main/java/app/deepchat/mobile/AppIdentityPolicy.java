package app.deepchat.mobile;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** 启动器图标与桌面快捷方式的白名单规则。 */
final class AppIdentityPolicy {
    static final String DEFAULT_ICON = "default";
    static final int MAX_SHORTCUT_LABEL_CHARS = 40;
    static final List<String> LAUNCHER_ICONS = Collections.unmodifiableList(
            Arrays.asList(DEFAULT_ICON, "ocean", "forest", "sunset")
    );
    static final List<String> SHORTCUT_TYPES = Collections.unmodifiableList(
            Arrays.asList("new", "voice", "camera")
    );

    private AppIdentityPolicy() {}

    static boolean isAllowedIcon(String icon) {
        return icon != null && LAUNCHER_ICONS.contains(icon);
    }

    static boolean isAllowedShortcutType(String type) {
        return type != null && SHORTCUT_TYPES.contains(type);
    }

    static String aliasClassName(String icon) {
        if (DEFAULT_ICON.equals(icon)) return "LauncherDefault";
        if ("ocean".equals(icon)) return "LauncherOcean";
        if ("forest".equals(icon)) return "LauncherForest";
        if ("sunset".equals(icon)) return "LauncherSunset";
        return null;
    }

    static String aliasComponentName(String packageName, String icon) {
        String alias = aliasClassName(icon);
        if (packageName == null || packageName.isEmpty() || alias == null) return null;
        return packageName + "." + alias;
    }

    static String shortcutId(String type, String icon) {
        if (!isAllowedShortcutType(type) || !isAllowedIcon(icon)) return null;
        return "deepchat-" + type + "-" + icon;
    }

    /** 只生成 #24 已支持的 action 路由，不生成 account 授权路由。 */
    static String shortcutData(String packageName, String type) {
        if (packageName == null || packageName.isEmpty() || !isAllowedShortcutType(type)) {
            return null;
        }
        return packageName + "://action?type=" + type;
    }

    /** 去掉控制字符、折叠空白并按码点截断，避免原生快捷方式标签异常。 */
    static String sanitizeShortcutLabel(String raw, String fallback) {
        String cleaned = cleanLabel(raw);
        if (cleaned.isEmpty()) cleaned = cleanLabel(fallback);
        if (cleaned.isEmpty()) cleaned = "Deep Chat";
        if (cleaned.codePointCount(0, cleaned.length()) <= MAX_SHORTCUT_LABEL_CHARS) {
            return cleaned;
        }
        int end = cleaned.offsetByCodePoints(0, MAX_SHORTCUT_LABEL_CHARS);
        return cleaned.substring(0, end);
    }

    private static String cleanLabel(String value) {
        if (value == null) return "";
        StringBuilder result = new StringBuilder(value.length());
        boolean pendingSpace = false;
        for (int index = 0; index < value.length(); ) {
            int codePoint = value.codePointAt(index);
            index += Character.charCount(codePoint);
            int type = Character.getType(codePoint);
            if (Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint)) {
                pendingSpace = result.length() > 0;
                continue;
            }
            if (Character.isISOControl(codePoint) || type == Character.FORMAT) continue;
            if (pendingSpace) result.append(' ');
            pendingSpace = false;
            result.appendCodePoint(codePoint);
        }
        return result.toString();
    }
}
