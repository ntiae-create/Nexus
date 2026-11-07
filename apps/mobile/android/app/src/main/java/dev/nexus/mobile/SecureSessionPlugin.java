package dev.nexus.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Secure store for the NEXUS session token.
 *
 * <p>Backed by {@link EncryptedSharedPreferences} with a {@link MasterKey} that lives
 * in the Android Keystore (hardware-backed where the device provides it). The
 * encrypted file is not readable through {@code adb} or a plain backup, unlike the
 * regular SharedPreferences that Capacitor's {@code Preferences} plugin uses.
 *
 * <p>Only the session token is stored here. The API base URL is configuration, not
 * a credential, and stays in the unencrypted Preferences store.
 *
 * <p>Every method reports failure explicitly: the JavaScript layer must never
 * assume the token was written when the keystore could not confirm it.
 */
@CapacitorPlugin(name = "SecureSession")
public class SecureSessionPlugin extends Plugin {

    private static final String TAG = "SecureSession";
    private static final String FILE_NAME = "nexus_secure_session";

    private SharedPreferences openStore() throws Exception {
        Context context = getContext();
        MasterKey masterKey = new MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();

        return EncryptedSharedPreferences.create(
                context,
                FILE_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    /** Returns the stored value or {@code null} when the key is absent. */
    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("A storage key is required");
            return;
        }

        try {
            String value = openStore().getString(key, null);
            JSObject result = new JSObject();
            result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            // The message never contains the stored value, only the failure kind.
            Log.e(TAG, "Unable to read the secure session entry");
            call.reject("Unable to read the secure session entry", error);
        }
    }

    /** Writes the value and fails loudly when the keystore rejects the operation. */
    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");

        if (key == null || key.isEmpty()) {
            call.reject("A storage key is required");
            return;
        }
        if (value == null) {
            call.reject("A value is required");
            return;
        }

        try {
            SharedPreferences.Editor editor = openStore().edit();
            editor.putString(key, value);
            // commit() rather than apply(): the caller must know whether the token
            // actually reached the disk before treating the session as established.
            if (!editor.commit()) {
                call.reject("The device could not persist the secure session entry");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            Log.e(TAG, "Unable to write the secure session entry");
            call.reject("Unable to write the secure session entry", error);
        }
    }

    /** Removes the value. Succeeds when the key was already absent. */
    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("A storage key is required");
            return;
        }

        try {
            SharedPreferences.Editor editor = openStore().edit();
            editor.remove(key);
            if (!editor.commit()) {
                call.reject("The device could not remove the secure session entry");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            Log.e(TAG, "Unable to remove the secure session entry");
            call.reject("Unable to remove the secure session entry", error);
        }
    }
}
