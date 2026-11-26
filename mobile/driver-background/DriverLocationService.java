package com.meshwari.driver;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class DriverLocationService extends Service implements LocationListener {
    public static final String ACTION_STOP = "com.meshwari.driver.STOP_LOCATION";
    private static final String TAG = "MeshwariDriverGPS";
    private static final String CHANNEL = "meshwari_driver_location";
    private static final int NOTIFICATION_ID = 7401;
    private static final String PREFS = "meshwari_driver_location";
    private LocationManager locationManager;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private volatile String token;
    private volatile String apiUrl;
    private volatile long lastSentAt = 0;

    @Override public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            securePreferences().edit().clear().apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        SharedPreferences prefs = securePreferences();
        if (intent != null) {
            String suppliedToken = intent.getStringExtra("token");
            String suppliedApi = intent.getStringExtra("apiUrl");
            if (suppliedToken != null) token = suppliedToken;
            if (suppliedApi != null) apiUrl = suppliedApi;
            prefs.edit().putString("token", token).putString("apiUrl", apiUrl).apply();
        } else {
            token = prefs.getString("token", null);
            apiUrl = prefs.getString("apiUrl", null);
        }
        if (token == null || apiUrl == null) { stopSelf(); return START_NOT_STICKY; }
        try {
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            beginLocationUpdates();
        } catch (Exception error) {
            Log.e(TAG, "Unable to start location foreground service", error);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private SharedPreferences securePreferences() {
        try {
            MasterKey masterKey = new MasterKey.Builder(this)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
            return EncryptedSharedPreferences.create(this, PREFS, masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to access encrypted driver location credentials", error);
        }
    }

    private void beginLocationUpdates() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf(); return;
        }
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER))
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 20000L, 0f, this, Looper.getMainLooper());
        } catch (SecurityException error) { Log.w(TAG, "GPS permission unavailable", error); }
        try {
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 20000L, 0f, this, Looper.getMainLooper());
        } catch (SecurityException error) { Log.w(TAG, "Network location permission unavailable", error); }
        try {
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last != null) onLocationChanged(last);
        } catch (SecurityException ignored) {}
    }

    @Override public void onLocationChanged(Location location) {
        long now = System.currentTimeMillis();
        if (now - lastSentAt < 15000L || token == null || apiUrl == null) return;
        lastSentAt = now;
        final String currentToken = token;
        final String currentApi = apiUrl;
        final double lat = location.getLatitude(), lng = location.getLongitude();
        network.execute(() -> sendLocation(currentApi, currentToken, lat, lng));
    }

    private void sendLocation(String base, String bearer, double lat, double lng) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(base.replaceAll("/+$", "") + "/driver/location");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("PUT");
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + bearer);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] body = new JSONObject().put("latitude", lat).put("longitude", lng).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            int status = connection.getResponseCode();
            if (status == 401 || status == 403 || status == 409) {
                Log.w(TAG, "Server rejected driver location with HTTP " + status + "; stopping service");
                stopSelf();
            } else if (status < 200 || status >= 300) {
                Log.w(TAG, "Location update failed with HTTP " + status);
            }
        } catch (Exception error) {
            Log.w(TAG, "Location upload failed; next GPS update will retry", error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "مشاركة موقع السائق", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("إشعار دائم أثناء استقبال الرحلات ومشاركة الموقع");
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("مشواري - مشاركة الموقع")
            .setContentText("موقعك يُحدّث أثناء استقبال الرحلات")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    @Override public void onDestroy() {
        if (locationManager != null) locationManager.removeUpdates(this);
        network.shutdownNow();
        stopForeground(true);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
