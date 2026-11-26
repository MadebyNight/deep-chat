package app.deepchat.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AppIdentityPolicyTest {
    @Test
    public void acceptsOnlyPresetIconsAndAliases() {
        for (String icon : AppIdentityPolicy.LAUNCHER_ICONS) {
            assertTrue(AppIdentityPolicy.isAllowedIcon(icon));
            assertTrue(AppIdentityPolicy.aliasClassName(icon).startsWith("Launcher"));
            assertEquals(
                    "app.deepchat.mobile." + AppIdentityPolicy.aliasClassName(icon),
                    AppIdentityPolicy.aliasComponentName("app.deepchat.mobile", icon)
            );
        }
        assertFalse(AppIdentityPolicy.isAllowedIcon("custom"));
        assertFalse(AppIdentityPolicy.isAllowedIcon(null));
        assertNull(AppIdentityPolicy.aliasClassName("custom"));
        assertNull(AppIdentityPolicy.aliasComponentName("app.deepchat.mobile", "custom"));
        assertNull(AppIdentityPolicy.aliasComponentName(null, "ocean"));
    }

    @Test
    public void buildsOnlyActionShortcutRoutes() {
        assertEquals(
                "app.deepchat.mobile://action?type=new",
                AppIdentityPolicy.shortcutData("app.deepchat.mobile", "new")
        );
        assertEquals(
                "new",
                ShareIntakePolicy.shortcutActionFor(
                        "app.deepchat.mobile",
                        "action",
                        "new",
                        "app.deepchat.mobile"
                )
        );
        assertNull(AppIdentityPolicy.shortcutData("app.deepchat.mobile", "account"));
        assertNull(ShareIntakePolicy.shortcutActionFor(
                "app.deepchat.mobile",
                "account",
                "authorized",
                "app.deepchat.mobile"
        ));
    }

    @Test
    public void createsStableShortcutIdsFromWhitelistedParts() {
        assertEquals("deepchat-new-ocean", AppIdentityPolicy.shortcutId("new", "ocean"));
        assertNull(AppIdentityPolicy.shortcutId("delete", "ocean"));
        assertNull(AppIdentityPolicy.shortcutId("new", "custom"));
    }

    @Test
    public void sanitizesShortcutLabels() {
        assertEquals(
                "Deep Chat 主题",
                AppIdentityPolicy.sanitizeShortcutLabel("\u0000 Deep\n\tChat   主题 ", "Deep Chat")
        );
        assertEquals(
                "Deep Chat",
                AppIdentityPolicy.sanitizeShortcutLabel(" \u0000 ", "Deep Chat")
        );
        String longLabel = AppIdentityPolicy.sanitizeShortcutLabel(
                "a".repeat(120),
                "Deep Chat"
        );
        assertEquals(
                AppIdentityPolicy.MAX_SHORTCUT_LABEL_CHARS,
                longLabel.codePointCount(0, longLabel.length())
        );
    }
}
