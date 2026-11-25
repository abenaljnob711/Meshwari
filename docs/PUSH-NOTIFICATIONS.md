# Meshwari push notifications

This release enables native Firebase Cloud Messaging (FCM) for the passenger and driver Android apps. The administration APK is intentionally excluded from native Push until its Firebase initialization and native registration flow are separately implemented and verified. Do not add an admin Firebase secret or bundle the Push plugin into the admin APK for this release.

## Android app configurations

The Firebase project must contain these Android applications:

- Passenger: `com.meshwari.app`
- Driver: `com.meshwari.driver`

Store the corresponding Android configuration files as GitHub Actions repository secrets:

- `FIREBASE_GOOGLE_SERVICES_PASSENGER_BASE64`
- `FIREBASE_GOOGLE_SERVICES_DRIVER_BASE64`

Each secret contains the Base64 encoding of its app's `google-services.json`. A single JSON file may contain multiple Android client entries, but the Google Services Gradle plugin must find a client matching the APK's exact application ID. Never commit these files or service-account credentials.

If either secret is absent, the current workflow warns and builds that APK without native FCM configuration. Such an APK must not be described as Push-enabled.

## Server credential

The API uses Firebase Cloud Messaging HTTP v1. Configure the Render environment variable `FIREBASE_SERVICE_ACCOUNT_JSON` with the complete service-account JSON for the same Firebase project. This is different from Android's `google-services.json`. Never commit it or put it in an APK.

The server validates the JSON and private-key format before reporting Push as configured. That validation does not prove that Google accepts the credential or that a device can receive a message; actual delivery still requires an end-to-end device test.

## Registration and delivery

- Passenger and driver apps bundle `@capacitor/push-notifications`, request Android notification permission, and register their FCM device tokens against the authenticated account.
- The server associates a device token with the currently authenticated passenger or driver and transfers it when the same token is registered by a different authenticated account.
- The app persists its device token locally so it can retry cleanup after a network failure during logout or factory reset.
- The server sends FCM messages for supported trip and account events and stores notification records for the in-app inbox.
- The passenger and driver apps expose an inbox where users can review notifications and mark them as read.
- The admin APK does not register a native FCM token in this release. Admin notifications remain available through the authenticated in-app notification refresh; native admin Push is not enabled.

## Release verification

1. Confirm both GitHub secrets exist and their Firebase clients match `com.meshwari.app` and `com.meshwari.driver`.
2. Confirm `FIREBASE_SERVICE_ACCOUNT_JSON` is configured on the API service without exposing its value.
3. Build the APKs only when an approved build run is available; do not infer FCM readiness from a source-code review.
4. Install passenger and driver APKs on physical Android devices and grant notification permission.
5. Sign in separately to each app and confirm device registration reaches the authenticated API.
6. Trigger a supported event and verify notification delivery while foregrounded and backgrounded.
7. Confirm each account sees only its own notification records and can mark them as read.
8. Verify logout and factory reset remove the server token when online; if offline, the cached token must remain available for cleanup.

A successful build or a health response that reports Push configuration does not prove end-to-end FCM delivery. Physical-device verification is required.
