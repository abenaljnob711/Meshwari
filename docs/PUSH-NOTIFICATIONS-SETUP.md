# Meshwari push notifications — Android setup

This release enables native Firebase Push for two separate Android apps. The admin APK is deliberately excluded from native Push until its Firebase initialization path is implemented and verified.

| App | Android package ID | Firebase secret |
|---|---|---|
| Passenger | `com.meshwari.app` | `FIREBASE_GOOGLE_SERVICES_PASSENGER_BASE64` |
| Driver | `com.meshwari.driver` | `FIREBASE_GOOGLE_SERVICES_DRIVER_BASE64` |
| Admin | `com.meshwari.admin` | No native Push secret in this release |

## Android configuration files

Register the passenger and driver package IDs in the same Firebase project. Download the matching `google-services.json` for each app and Base64-encode the complete file into its corresponding GitHub Actions repository secret.

The build workflow places each decoded file in that app's Android module and applies the Google Services Gradle plugin only when the file is present. If a secret is missing, the workflow warns and produces an APK without native FCM configuration; that APK is not Push-ready. The Gradle plugin selects the matching client by application ID, so a JSON containing multiple clients is acceptable only when it contains the exact package entry.

Never commit Android Firebase JSON files or service-account credentials.

## Server-side sending

The API requires `FIREBASE_SERVICE_ACCOUNT_JSON` as a Render environment variable. Its value is the complete Firebase service-account JSON for the same Firebase project. Do not use an Android `google-services.json` file as the server credential, and never place the service-account private key in an APK or repository.

## Android permissions and behavior

- Passenger and driver declare `POST_NOTIFICATIONS` and `VIBRATE`; they also bundle the Capacitor Push Notifications plugin.
- Android 13 and later require the user to grant notification permission.
- The apps register device tokens against the currently authenticated account.
- The app stores the token locally to support cleanup retries after network failures during logout or factory reset.
- The admin APK does not include the native Push plugin bundle and does not register a device token. Admin inbox updates use the authenticated in-app refresh path only.
- Do not request battery-optimization exemptions or run a permanent background service solely for ordinary FCM delivery.

## Release verification

1. Confirm the two Firebase Android secrets and their package IDs.
2. Confirm the server service-account variable is set and valid.
3. Install the passenger and driver APKs on physical devices and grant notification permission.
4. Sign in to each app and verify authenticated token registration.
5. Test a supported trip/account event with the target app foregrounded and backgrounded.
6. Confirm passenger and driver inboxes show only the correct account's notifications and read-state updates work.
7. Test logout and factory reset while online, then verify the token is removed server-side.
8. Repeat cleanup with network unavailable and verify the local token remains available for a later retry.

A source review, successful compilation, or health endpoint alone cannot prove real FCM delivery. Physical-device testing is mandatory.
