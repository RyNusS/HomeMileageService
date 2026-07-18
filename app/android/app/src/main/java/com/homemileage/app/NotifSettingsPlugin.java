package com.homemileage.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens the Android system notification-channel settings so the user can pick
 * a notification sound and vibration pattern from the phone's own list.
 */
@CapacitorPlugin(name = "NotifSettings")
public class NotifSettingsPlugin extends Plugin {

    private static final String DEFAULT_CHANNEL_ID = "hms_default";
    // "\ud648 \ub9c8\uc77c\ub9ac\uc9c0 \uc54c\ub9bc" (app notification channel name)
    private static final String DEFAULT_CHANNEL_NAME = "\ud648 \ub9c8\uc77c\ub9ac\uc9c0 \uc54c\ub9bc";

    @PluginMethod
    public void openChannelSettings(PluginCall call) {
        String channelId = call.getString("channelId", DEFAULT_CHANNEL_ID);
        Context ctx = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(channelId) == null) {
                NotificationChannel ch = new NotificationChannel(
                        channelId, DEFAULT_CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
                nm.createNotificationChannel(ch);
            }
            intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
            intent.putExtra(Settings.EXTRA_CHANNEL_ID, channelId);
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + ctx.getPackageName()));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        call.resolve();
    }
}
