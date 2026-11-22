# Meshwari voice calls

Passenger and driver voice calls use WebRTC peer-to-peer audio. The API stores only short-lived call signaling data (SDP and ICE candidates); it does not record or store audio.

## Required Android permissions

The passenger and driver APK build workflow adds:
- \`android.permission.RECORD_AUDIO\`
- \`android.permission.MODIFY_AUDIO_SETTINGS\`

Capacitor Android 7.4.3 handles the runtime microphone permission request from WebView's audio capture permission callback.

## STUN and TURN

The server always supplies Google's public STUN endpoint as a direct-connection fallback. STUN alone is not sufficient on every carrier, NAT, firewall, or Wi-Fi network. For reliable mobile-to-mobile calls, configure a TURN provider that supports the coturn REST-style shared-secret credential scheme.

Set these environment variables on the Meshwari Render web service:

- \`TURN_URLS\`: comma-separated TURN URLs supplied by the provider, for example \`turn:turn.example.net:3478?transport=udp,turns:turn.example.net:5349?transport=tcp\`.
- \`TURN_SHARED_SECRET\`: the provider's shared secret for time-limited HMAC-SHA1 credentials. Do not use an ordinary API key unless the provider explicitly documents compatibility with this credential scheme.

The server creates a time-limited username and HMAC-SHA1 password for each authenticated account. Never put the shared secret in the APK, web page, or Git repository.

After setting the variables, restart/deploy the Render service. Check \`GET /api/health\`; the response should contain \`voiceCalls.turnRelayConfigured: true\`. If false, calls can still try STUN, but some networks will fail to connect.

## Call lifecycle and cleanup

- Calls can start only after the trip is accepted and while it is accepted, arrived, or in progress.
- Only the passenger and assigned driver can read or update call signaling.
- A ringing request expires after its short initial timeout.
- An accepted call renews a 90-second server lease with authenticated heartbeats while the app is active. If a client disappears, the call becomes stale and is cleaned up.
- Calls are ended when the trip is cancelled or completed.
- ICE signaling rows and ended call records are cleaned up automatically.
- The microphone tracks are stopped when the call ends, the trip disappears from the active-trip list, or the user logs out.

## Important limits

Incoming-call ringing/notifications while the app is closed or fully suspended are not implemented by this WebRTC foreground flow. That requires a push-notification service and native call-notification integration. Test audio with two real devices and different mobile networks after TURN is configured; a successful APK build does not prove end-to-end audio connectivity.
