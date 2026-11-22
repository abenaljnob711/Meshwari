# Meshwari push notifications

This repository contains the application and server integration for Android push notifications. Real delivery requires three Firebase Android app configurations and one Firebase service-account credential. Never commit service-account credentials or paste them into source files.

## Firebase Android apps

Create one Firebase project, then register these three Android applications in that same project:

- Passenger: \`com.meshwari.app\`
- Driver: \`com.meshwari.driver\`
- Admin: \`com.meshwari.admin\`

Download the matching \`google-services.json\` separately for each Android package. Encode each file as one base64 string and add these GitHub Actions repository secrets:

- \`FIREBASE_GOOGLE_SERVICES_PASSENGER_BASE64\`
- \`FIREBASE_GOOGLE_SERVICES_DRIVER_BASE64\`
- \`FIREBASE_GOOGLE_SERVICES_ADMIN_BASE64\`

The APK workflow bundles \`@capacitor/push-notifications\`, places each matching Firebase file into that app's Android module, and builds all three APKs. If a secret is absent, that APK still builds but native push registration cannot complete.

## Server credential

In the Firebase project, create a service account permitted to send Firebase Cloud Messaging messages. Store the complete service-account JSON as the Render environment variable:

- \`FIREBASE_SERVICE_ACCOUNT_JSON\`: the complete JSON document, as a single environment-variable value

Do not use the Android \`google-services.json\` file as the server credential; they are different files with different purposes.

After setting the variable, deploy the Meshwari API. The server uses Firebase OAuth and FCM HTTP v1; it never puts the service-account private key in an APK.

## Delivery flows

- When a passenger requests a taxi, the API saves a persistent notification for the selected driver and sends an FCM notification to registered driver devices.
- When an active account requests a login/verification code, the API saves a notification for the owner administrator and all administrators with registered devices, then sends FCM to their devices.
- Device tokens are tied to the authenticated account/admin identity. Users can remove their own token; invalid FCM tokens are deleted when Firebase reports them as unregistered.
- The notification inbox is available through authenticated \`GET /api/notifications\`.

The app requests Android notification permission, registers its FCM token, and receives foreground notification events. The operating system displays FCM notification messages when the app is backgrounded or closed, subject to Android notification permission, device power/network policy, and Firebase configuration.

## Verification checklist

1. Confirm the three GitHub secrets are present and each file's package name matches its APK.
2. Set \`FIREBASE_SERVICE_ACCOUNT_JSON\` on Render and deploy the API.
3. Install all three newly built APKs on physical Android devices and grant notification permission.
4. Sign in once on the driver and admin devices so their FCM tokens are registered.
5. Create a passenger trip for the driver and verify a system notification appears when the driver app is backgrounded.
6. From a separate active account, request a login code and verify the administrator receives a system notification while the admin app is backgrounded.
7. Verify the same events appear in each authenticated notification inbox.

A green GitHub build only proves compilation and automated tests. It does not prove Firebase credentials, device registration, Android delivery, or background display; those require the physical-device checks above.
