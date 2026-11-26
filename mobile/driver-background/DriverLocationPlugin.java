package com.meshwari.driver;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.content.pm.PackageManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DriverLocation")
public class DriverLocationPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        String token = call.getString("token");
        String apiUrl = call.getString("apiUrl");
        if (token == null || token.trim().isEmpty() || apiUrl == null || !apiUrl.startsWith("https://")) {
            call.reject("بيانات تشغيل خدمة الموقع غير مكتملة");
            return;
        }
        if (getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            getContext().checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            call.reject("يجب السماح بموقع الجهاز أولاً");
            return;
        }
        if (Build.VERSION.SDK_INT >= 29 &&
            getContext().checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            Intent settings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("فعّل إذن الموقع طوال الوقت من إعدادات التطبيق، ثم أعد تفعيل استقبال الرحلات");
            return;
        }
        Intent intent = new Intent(getContext(), DriverLocationService.class);
        intent.putExtra("token", token);
        intent.putExtra("apiUrl", apiUrl);
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent);
        else getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), DriverLocationService.class);
        intent.setAction(DriverLocationService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }
}
