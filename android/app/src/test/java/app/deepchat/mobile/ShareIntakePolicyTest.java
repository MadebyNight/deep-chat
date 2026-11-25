package app.deepchat.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;

public class ShareIntakePolicyTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void stripsPathSegmentsControlsAndLeadingPunctuation() {
        assertEquals(
                "secret.pdf",
                ShareIntakePolicy.sanitizeDisplayName("../../secret.pdf", "application/pdf")
        );
        assertEquals(
                "shared-file.txt",
                ShareIntakePolicy.sanitizeDisplayName("\u0000..\\", "text/plain")
        );
        assertEquals(
                "report_1_.pdf",
                ShareIntakePolicy.sanitizeDisplayName("report#1%.pdf", "application/pdf")
        );
        String longName = ShareIntakePolicy.sanitizeDisplayName(
                "a".repeat(300) + ".pdf",
                "application/pdf"
        );
        assertTrue(longName.length() <= ShareIntakePolicy.MAX_NAME_CHARS);
        assertTrue(longName.endsWith(".pdf"));
    }

    @Test
    public void derivesOnlyKnownExtensionsFromMime() {
        assertEquals(
                "photo.jpg",
                ShareIntakePolicy.sanitizeDisplayName("photo", "image/jpeg")
        );
        assertEquals(
                "scan.heic",
                ShareIntakePolicy.sanitizeDisplayName("scan.heic", "image/heic")
        );
        assertTrue(ShareIntakePolicy.isAllowedExtension("docx"));
        assertTrue(ShareIntakePolicy.isAllowedExtension("PNG"));
        assertFalse(ShareIntakePolicy.isAllowedExtension("exe"));
        assertFalse(ShareIntakePolicy.isAllowedExtension("heic"));
        assertFalse(ShareIntakePolicy.isAllowedExtension("rtf"));
        assertFalse(ShareIntakePolicy.isAllowedExtension("odt"));
        assertEquals("text/markdown", ShareIntakePolicy.mimeForName("notes.MD"));
    }

    @Test
    public void appliesHardIntakeLimits() {
        assertFalse(ShareIntakePolicy.exceedsFileCount(10));
        assertTrue(ShareIntakePolicy.exceedsFileCount(11));
        assertFalse(ShareIntakePolicy.exceedsTextLength(64 * 1024));
        assertTrue(ShareIntakePolicy.exceedsTextLength(64 * 1024 + 1));
        assertFalse(ShareIntakePolicy.exceedsFileSize(32L * 1024 * 1024));
        assertTrue(ShareIntakePolicy.exceedsFileSize(32L * 1024 * 1024 + 1));
        assertFalse(ShareIntakePolicy.exceedsTotalSize(64L * 1024 * 1024));
        assertTrue(ShareIntakePolicy.exceedsTotalSize(64L * 1024 * 1024 + 1));
    }

    @Test
    public void rejectsPathsOutsideIntakeDirectory() throws Exception {
        File root = temporaryFolder.newFolder("share-intake");
        File child = new File(root, "id/report.pdf");
        File sibling = new File(root.getParentFile(), "outside.pdf");
        assertTrue(ShareIntakePolicy.isWithinDirectory(root, child));
        assertFalse(ShareIntakePolicy.isWithinDirectory(root, sibling));
        assertFalse(ShareIntakePolicy.isWithinDirectory(root, new File(root, "../outside.pdf")));
    }

    @Test
    public void acceptsOnlyContentProviderInputs() {
        assertTrue(ShareIntakePolicy.isValidUriScheme("content"));
        assertTrue(ShareIntakePolicy.isValidUriScheme("CONTENT"));
        assertFalse(ShareIntakePolicy.isValidUriScheme("file"));
        assertFalse(ShareIntakePolicy.isValidUriScheme(null));
    }

    @Test
    public void isolatesShortcutRoutesFromOauthCallback() {
        assertEquals(
                "voice",
                ShareIntakePolicy.shortcutActionFor(
                        "app.deepchat.mobile",
                        "action",
                        "voice",
                        "app.deepchat.mobile"
                )
        );
        assertEquals(
                "camera",
                ShareIntakePolicy.shortcutActionFor(
                        "deepchat",
                        "action",
                        "camera",
                        "app.deepchat.mobile"
                )
        );
        assertEquals(
                "new",
                ShareIntakePolicy.shortcutActionFor(
                        "deepchat.mobile",
                        "action",
                        "new",
                        "app.deepchat.mobile"
                )
        );
        assertNull(ShareIntakePolicy.shortcutActionFor(
                "app.deepchat.mobile",
                "account",
                "authorized",
                "app.deepchat.mobile"
        ));
        assertNull(ShareIntakePolicy.shortcutActionFor(
                "other.app",
                "action",
                "camera",
                "app.deepchat.mobile"
        ));
        assertNull(ShareIntakePolicy.shortcutActionFor(
                "app.deepchat.mobile",
                "action",
                "delete",
                "app.deepchat.mobile"
        ));
    }
}
