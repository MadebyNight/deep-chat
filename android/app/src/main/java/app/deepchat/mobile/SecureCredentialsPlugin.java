package app.deepchat.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureCredentials")
public class SecureCredentialsPlugin extends Plugin {
    private static final String ALIAS = "deepchat.credentials.v1";

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("secure_credentials", Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
    }

    @PluginMethod
    public void read(PluginCall call) {
        try {
            String value = preferences().getString("ciphertext", null);
            JSObject result = new JSObject();
            if (value == null) {
                result.put("value", JSObject.NULL);
            } else {
                String iv = preferences().getString("iv", "");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
                result.put("value", new String(cipher.doFinal(Base64.decode(value, Base64.NO_WRAP)), StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception e) {
            call.reject("无法解锁连接配置，请重新连接。");
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String value = call.getString("value");
        try {
            SharedPreferences.Editor editor = preferences().edit();
            if (value == null) {
                editor.clear();
            } else {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key());
                editor.putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
                editor.putString("ciphertext", Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
            }
            if (!editor.commit()) throw new IllegalStateException("Write failed");
            call.resolve();
        } catch (Exception e) {
            call.reject("无法安全保存连接配置，请重试。");
        }
    }
}
