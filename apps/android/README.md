# RoadwiseFleet driver app (`apps/android/`)

Native Android driver app — Kotlin + Jetpack Compose. The Play identity
(`applicationId`) is `com.roadwisefleet`, matching the existing Play Console app
(board #122); the Kotlin namespace and package names stay
`com.elilaltd.roadwisefleet.driver`. This directory is the **A1 scaffold**
(board `eila/tasks#103`, epic `#102`): the shell, the offline store, the sync
engine and the i18n wiring that A2–A5 build on.

Architecture, the module map, the offline model, distribution and signing
ownership: [`docs/android-architecture.md`](../../docs/android-architecture.md).

## Modules

| Module  | What lives here |
| ------- | --------------- |
| `:app`  | Application, navigation, the 5-tab one-thumb shell, SOS, FCM wiring, manual DI container. |
| `:core` | UI-free: trip-status mirror, capture rules, outbox planner, Room store, sync engine, API client, tracking queue (A4), i18n catalogues. |

## Background tracking (A4, board #106)

Sampling runs **only while a trip's `tracking` flag is true** (set by Start Trip,
cleared at DELIVERED): `TrackingScheduler` starts `LocationTrackingService` — a
`foregroundServiceType="location"` service with a 10-minute
`PRIORITY_BALANCED_POWER_ACCURACY` request — and stops it when the flag is off.
`GpsFlushWorker` (WorkManager) drains the Room `gps_points` queue in batches;
`TrackingBootReceiver` resumes an active trip after a reboot.
`TrackingCore` (pure) holds the cadence, validation and batching rules, so the
JVM unit tests pin them without a device. API side: `POST /api/trips/:id/gps`
plus the SSE streams. Trade-offs and the battery note:
[`docs/android-architecture.md`](../../docs/android-architecture.md) §9c.

## Sign-in and auth gate (A2 reopen, board #104)

The app opens on the **login screen**, never on the shell. `MainActivity`
composes `AuthController` (`:core`) and renders `LoginScreen` until a driver
session exists; the shell is only reachable from `AuthState.SignedIn`.

- First run: `POST /api/auth/login` (email + password, inline 401/423/network
  errors, no self-signup or reset). A non-driver role is refused with "use the
  fleet web app" and the session is cleared.
- On success: the Keystore EC P-256 key is created (first use) and
  `POST /api/auth/device/register` binds it; `credentialId` + device label are
  persisted. Registration failure keeps the password session and shows a
  non-blocking notice.
- Relaunch with a `credentialId`: challenge -> sign -> verify, no password.
  A revoked/expired credential is cleared and the login screen returns.
- More > Sign out: best-effort `POST /api/auth/device/revoke`, then the token,
  credential and user fields are removed and the login screen returns. The
  language choice is kept.

### Email code sign-in (board #125)

- **Email me a code** on the login screen asks the server to mail a 6-digit
  code, then `EmailCodeScreen` takes the code with a local resend countdown
  (the server enforces a 60 s gap). Success goes through the SAME post-login
  path as a password (`AuthController.completeSignIn`): role gate, session,
  Keystore registration, shell. A wrong digit keeps the driver on the code
  screen.
- The button is hidden when `GET /api/auth/otp/email/status` reports
  `configured: false` — i.e. until #124 puts the SMTP credential on the host.
  The app never holds an SMTP credential.
- **Continue with WhatsApp** is compiled in only with
  `-Proadwisefleet.whatsappOtp=true` (default off) and calls nothing until the
  #124 provider exists.

Contract and threat notes: `docs/android-architecture.md` §9a/§9a.1/§9a.2; flow:
`diagrams/17-android-auth-flow.mmd`. JVM tests: `AuthRulesTest`,
`AuthControllerTest`; on-device: `KeystoreDeviceKeyMaterialInstrumentedTest`,
`AuthOtpUiTest` (the #125 UI gate — WhatsApp is not composed while the flag is
off, "Email me a code" only with a configured sender, six-digit form, resend
countdown, error and loading states).

## Build

**CI is the build source of truth** (`.github/workflows/android-release.yml`),
but the developer host now also has a toolchain: JDK 21, Gradle 8.14.3 and the
Android SDK (platforms 35/36/37) — enough to run the debug build and the JVM
unit tests locally. `.github/workflows/android-release.yml` builds
`./gradlew --no-daemon assembleDebug` for any PR touching `apps/android/**` and
uploads `apps/android/app/build/outputs/apk/debug/app-debug.apk` as the
`android-release` artifact.

Locally (or on any machine with JDK 21 + Android SDK platform 36):

```sh
cd apps/android
./gradlew --no-daemon assembleDebug   # debug APK
./gradlew --no-daemon bundleRelease   # AAB the Play upload consumes
./gradlew --no-daemon test            # JVM unit tests (:core domain rules)
```

## i18n

The four catalogues under `core/src/main/assets/locales/` are a **superset** of
`pilot/locales/{en,de,pl,tr}.json` (board task #6): every pilot key is copied
verbatim, and the app-only chrome (`nav.*`, `auth.*`, `driver.sos*`,
`driver.shell.*`) is added on top in all four languages.
`tools/check-locales.mjs` proves the copies have not drifted and that the four
catalogues share one app-only key set:

```sh
node apps/android/tools/check-locales.mjs
```

## Secrets

None. Signing material, the Play service-account key and the FCM server
credential live only in GitHub secrets (`infra/android-release.md`); the FCM
`google-services.json` client config is optional and never this repo's concern
(the guard is `infra/checks/android-release-check.sh`).
