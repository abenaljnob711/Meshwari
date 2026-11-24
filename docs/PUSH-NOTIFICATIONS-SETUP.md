# Meshwari push notifications (three Android apps)

This project ships three independent Android packages:

| App | Android package ID | GitHub Actions secret |
|---|---|---|
| Passenger | `com.meshwari.app` | `FIREBASE_GOOGLE_SERVICES_PASSENGER_BASE64` |
| Driver | `com.meshwari.driver` | `FIREBASE_GOOGLE_SERVICES_DRIVER_BASE64` |
| Admin | `com.meshwari.admin` | `FIREBASE_GOOGLE_SERVICES_ADMIN_BASE64` |

## Firebase Android files

Create/register all three Android apps in the Firebase project using the exact package IDs above. Download each app's own `google-services.json` file. Base64-encode each file and add it to the matching GitHub Actions repository secret. Do not commit any of these JSON files or service-account credentials.

The APK workflow installs the Google Services Gradle plugin only when the matching Firebase file is supplied. If a secret is missing, the workflow warns that push notifications for that APK are not configured; a successful APK build alone does not prove push delivery works.

## Server-side sending

The Render web service must have `FIREBASE_SERVICE_ACCOUNT_JSON` configured with the Firebase service-account JSON for the same Firebase project. Keep the value secret; never paste it into chat or commit it to the repository. The server sends messages through Firebase Cloud Messaging HTTP v1.

## Battery and Android permissions

- All three APKs declare `POST_NOTIFICATIONS` and `VIBRATE`.
- Passenger and driver additionally request microphone and location permissions for their own features.
- Push delivery is handled by Android/FCM; the apps should not keep a permanent polling loop or an always-on background service just to receive notifications.
- The apps refresh the notification inbox when opened or returned to the foreground. FCM handles delivery while the app is backgrounded or not running, subject to Android notification permission, device/network settings, and valid Firebase configuration.
- Do not request battery-optimization exemption for ordinary push notifications. Ask users to exempt the app only if a separately verified feature genuinely requires continuous background execution.

## Release verification

Before release, install and test all three APKs separately:
1. Confirm package IDs and app names.
2. Grant notification permission on Android 13+.
3. Send a test notification to each app while foregrounded, backgrounded, and after swiping it away.
4. Confirm each app receives only its intended account notifications.
5. Check that no permanent polling or unnecessary foreground service is running.
