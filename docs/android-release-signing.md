# Android release signing for Meshwari

The APK workflow now produces signed release APKs and refuses to build if the four signing secrets are absent. It uses one keystore for passenger, driver, and admin, then verifies that all three APKs have the same signing-certificate SHA-256 digest.

## Create the permanent key once

On a trusted computer or Android Termux with Java/keytool installed, create a dedicated keystore:

```sh
keytool -genkeypair -v \
  -keystore meshwari-release.jks \
  -alias meshwari-release \
  -keyalg RSA -keysize 4096 -validity 10000
```

Choose a strong, unique keystore password and key password. Keep the alias exactly as `meshwari-release` unless the GitHub secret is changed to match.

Encode the keystore as one Base64 line:

```sh
base64 meshwari-release.jks | tr -d '\n' > meshwari-release-base64.txt
```

Add these GitHub repository Actions secrets under Settings -> Secrets and variables -> Actions:

- `ANDROID_KEYSTORE_BASE64`: complete contents of `meshwari-release-base64.txt`.
- `ANDROID_KEYSTORE_PASSWORD`: the keystore password.
- `ANDROID_KEY_ALIAS`: `meshwari-release`.
- `ANDROID_KEY_PASSWORD`: the key password.

Do not send these values in chat, commit them, or store the private keystore in the repository. Keep at least two encrypted offline recovery copies of the keystore and passwords in separate secure locations. Losing this key prevents future APK updates from being signed as the same publisher.

## Important upgrade compatibility warning

The previously generated APKs were debug builds. Their debug signing certificate is not the permanent release certificate configured here. Android normally refuses an in-place update when the signing certificate changes. The first installation of the newly release-signed APKs may therefore require uninstalling the old debug-signed apps first. Server-side accounts and trips remain on the server, but any local-only app data can be lost. Back up local-only data before uninstalling.

All subsequent updates must use this exact same keystore and alias. Never generate a replacement key for routine releases.

## Versioning

The workflow stamps each application with the GitHub workflow run number as Android `versionCode`, and a corresponding `versionName`. Do not reset the workflow run history or reuse lower version codes when distributing updates.

## Verification

The workflow runs `apksigner verify` on each output and checks that the three certificate SHA-256 digests match. A successful workflow run is still required before declaring the release build verified.
