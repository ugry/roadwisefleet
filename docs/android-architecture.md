# ADR: Android driver app architecture

- **Status:** Accepted
- **Date:** 2026-10-01
- **Board:** `eila/tasks#103` (AND1-A1), epic `#102`
- **Companion:** `reports/android-app-direction-20261001.md` (product direction,
  owned by AND1-TL1 / landed via AND1-DOC1). This ADR is the engineering half:
  it fixes the module map, the offline model, the distribution and the signing
  ownership that A2–A5 build against.

## 1. Context

The driver surface today is the PWA `pilot/driver.html` (board #4). The owner
asked for a real Android app. AND1 delivers it as a wave:

| Task | Scope | Depends on |
| ---- | ----- | ---------- |
| **#103 (A1)** | Scaffold, this ADR, Compose shell, Room offline store, sync engine, FCM wiring, i18n | — |
| #104 (A2) | Passwordless, device-bound auth (Keystore keypair + backend challenge/verify) | A1 |
| #105 (A3) | Trip phases + `Start Trip` tracking gate (backend + app) | A1 |
| #106 (A4) | Battery-gated 10-min location upload | A3 |
| #107 (A5) | Cargo-scoped customer/fleet tracking | A3+A4 |
| #108 (QA1) | End-to-end QA | A2–A5 |
| #109 (OPS1) | Signing + Play distribution | owner decision (done) |

Owner decisions recorded on `#102` (2026-10-01): **distribution = Google Play,
internal testing → production**; the 10-minute tracking cadence stands **but
must be battery-conscious** (location only while `tracking = true`, batched
upload, stops at DELIVERED); solo drivers use the **same app**, menus driven by
account type (`#111`, `#112`).

## 2. Native Kotlin + Compose, not a WebView shell

The PWA is kept for the pilot/demo, but the product app is native Kotlin +
Jetpack Compose. A WebView wrapper was rejected because every differentiating
feature of AND1 is a native capability the web platform cannot give reliably:

- **Background location with a hard battery budget (#106).** Play policy and
  Doze make a web-based 10-minute cadence unreliable; `FusedLocationProvider`
  with a foreground/tracking gate is the supported path.
- **FCM delivery (#103) and a device-bound credential (#104).** The Keystore and
  StrongBox are only reachable from native code — the private key must never
  leave the device.
- **Offline-first store and queue (#103).** Room + a durable outbox survives
  process death; an IndexedDB queue in a WebView does not survive eviction.
- **A one-thumb, always-visible SOS shell** is a native window concern, not a
  page chrome concern.

Trade-off accepted: no code reuse with the PWA UI. The *rules* are reused — the
trip state machine and outbox planner in `:core` are ports of
`apps/api/src/trip-status.js` and `pilot/lib/driver-core.js`, and the locale
catalogues are literal copies (§5).

## 3. Module map

A1 lands two Gradle modules; the target map below is what A2–A5 extract from
them. Two modules now keeps the first scaffold buildable while giving each
parallel task a clear home.

```
apps/android/
├── settings.gradle.kts          # :app, :core
├── build.gradle.kts             # plugin versions (apply false)
├── gradle/libs.versions.toml    # the single version catalog
├── gradlew, gradle/wrapper/     # wrapper (gradle-wrapper.jar IS tracked)
├── tools/check-locales.mjs      # locale-parity guard
├── app/                         # :app — Android application
│   └── src/main/java/com/elilaltd/roadwisefleet/driver/
│       ├── RoadwiseApp.kt, MainActivity.kt
│       ├── di/AppContainer.kt           # manual DI, LocalAppContainer
│       ├── session/SessionStore.kt      # the signed-in driver (+ A2 device credential)
│       ├── push/                        # PushRegistrar, RoadwiseMessagingService (FCM)
│       ├── ui/DriverShell.kt            # 5 tabs + always-visible SOS
│       ├── ui/DriverDestination.kt      # the tab registry
│       ├── ui/trips/TripsScreen.kt      # current trip, next legal status, sync chip
│       ├── ui/theme/Theme.kt
│       └── res/                         # values{,-de,-pl,-tr}, themes
└── core/                        # :core — UI-free domain + data
    └── src/main/java/com/elilaltd/roadwisefleet/core/
        ├── model/                        # TripStatus, TripCore, models (pure, JVM-tested)
        ├── i18n/                         # Catalog, I18n, Translator, LocaleController
        ├── data/local/                   # Room entities, DAOs, RoadwiseDatabase
        ├── data/remote/ApiClient.kt      # HttpURLConnection, ApiResult
        ├── data/repo/TripRepository.kt   # local-first write path
        └── data/sync/                    # ConnectivityObserver, SyncEngine
    └── src/main/assets/locales/          # en/de/pl/tr.json (pilot copies + shell keys)
```

Target extraction as the wave grows (each is a plain move of a package):

| Future module | From | Owner task |
| ------------- | ---- | ---------- |
| `:core:model` | `core/model`, `core/i18n` | — |
| `:core:data` | `core/data/local`, `core/data/repo` | A3/A4 tables |
| `:core:network` | `core/data/remote` | A2 auth endpoints |
| `:feature:auth` | `session` + new device-credential code | A2 |
| `:feature:tracking` | new location/GPS package | A3/A4 |
| `:feature:tracking-share` | — | A5 |

Package convention: `com.elilaltd.roadwisefleet.driver.*` (app) and
`com.elilaltd.roadwisefleet.core.*` (library). The application id is
`com.elilaltd.roadwisefleet.driver` — the package name `#109` already targets.

## 4. Offline model

**Local-first, server-authoritative.** Every driver write goes through
`TripRepository` into the Room `outbox` and returns immediately; `SyncEngine`
replays it when there is connectivity. Reads come from Room, so the shell is
usable offline once a trip has been loaded.

- **Trip cache.** `trips` holds the current assignment (route, cargo, truck,
  rate, status) with the document list as a JSON column. A1 keeps this flat to
  stay one migration wide; the replacement trigger is A4's per-capture rows —
  then the documents become a relation table and `exportSchema` turns on with an
  explicit migration.
- **Outbox.** `outbox` is an ordered, attempt-counted queue of `status`,
  `document` and `sos` items carrying their exact request payloads, so a sync
  never re-derives anything. Ordering is per item `createdAtEpochMs`.
- **Failure policy** (`TripCore.classifyFailure`): network errors, 408/429 and
  5xx **retry** (attempts++); 4xx the server will never accept are **dropped**
  and surfaced to the driver, so a permanently-rejected change cannot block the
  queue behind it forever.
- **Captures.** A capture taken offline keeps its bytes locally
  (`pending_captures`) and its metadata (`capturedAt`, `lat`, `lng`, `accuracyM`)
  is validated *before* it is queued — a malformed fix is rejected rather than
  silently stored, and a future timestamp is a clock problem the driver sees.
- **Reconnect.** `ConnectivityObserver` (a `NetworkCallback` flow) plus a
  60-second retry tick drain the queue. A3 extends this: `tracking = true` while
  a trip is active only, and `false` at DELIVERED.

## 5. Internationalisation (EN / DE / PL / TR)

The four catalogues under `core/src/main/assets/locales/` are **supersets** of
`pilot/locales/*.json`: every pilot key is copied verbatim, and the app-shell
chrome (`nav.*`, `driver.sos*`, `common.confirm`, `driver.shell.*`) is added on
top in all four languages. `tools/check-locales.mjs` fails if either half drifts
(a pilot key changes in the app, the app-only set diverges between languages, or
the four catalogues stop covering the same base keys).

The resolver mirrors `pilot/lib/i18n.js`: explicit choice → remembered choice →
user language → org default → device language → English, and the translator
falls back catalogue → English → the key itself (never a blank line) with CLDR
plural rules per language. Switching language in the shell is immediate and
persists in `SessionStore`.

The shell keys are the only English authored for this app; the shared keys come
with the pilot's existing DE/PL/TR translations. The v4 menus (`#110`, `#112`)
are expected to extend this same block.

## 6. FCM and push

`firebase-messaging` is a dependency from A1, but the Google Services plugin is
applied **only when `app/google-services.json` exists**. That keeps the scaffold
buildable with no Firebase project while making the client config a drop-in.
`PushRegistrar.currentToken()` returns `null` (push disabled) until Firebase is
initialised; `RoadwiseMessagingService` receives registration refreshes and data
pushes and logs only the event type — the token is a device credential and is
never logged. A2 registers the token against the device credential.

## 7. Distribution

Owner decision (`#102`): **Google Play — internal testing first, then
production.** `#109` owns the Play account, the Data Safety declaration and the
background-location justification.

- Play receives the signed **AAB** (`bundleRelease`) from
  `.github/workflows/android-release.yml`, via the `google-play` environment and
  the `PLAY_SERVICE_ACCOUNT_JSON` secret.
- The **debug APK** (`assembleDebug`) is the CI/pilot artifact — it is what CI
  proves on every PR that touches `apps/android/**`, uploaded as the
  `android-release` artifact.
- A direct-APK sideload remains a fallback for pilot drivers who are not on
  Play; it is not the product channel.

## 8. Signing ownership

- The release keystore is **owned by the owner (ugur)** — the Play account, the
  upload key and its recovery are owner assets, not an agent's.
- The repository never holds signing material. `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`
  live only in GitHub secrets and are decoded to the runner's temp dir for the
  build (then deleted). `infra/android-release.md` is the operator runbook;
  `infra/checks/android-release-check.sh` is the CI guard.
- Rotation: if the upload key is lost, Play's upload-key reset is the recovery
  path — the keystore stays outside the repo, so a leak of this repository does
  not leak the key.

## 9. Security notes

- **A2 (device-bound auth):** an EC P-256 keypair is generated in the Android
  Keystore (StrongBox when available); the private key never leaves the device
  and is never logged; the server stores only the public key (SPKI). Sessions
  are challenge/verify with a single-use, short-TTL nonce; a lost phone is
  revoked server-side by device credential. A1's `SessionStore` holds the bearer
  token in private app storage and is the seam A2 replaces.
- **No secrets in the repo:** the `android-release-check` CI job fails on a
  tracked keystore, a PEM key, a service-account JSON, an inline blob, or a
  signing value not taken from `secrets.`.
- **Least privilege on the device:** A1 requests only `INTERNET`,
  `ACCESS_NETWORK_STATE` and `POST_NOTIFICATIONS`; location (A3/A4) and camera
  (A4) are added by the task that first uses them.

## 9a. Passwordless device auth (A2, #104)

Owner direction: after the **first** Android login (password or phone OTP) the
app generates an **EC P-256 keypair in the Android Keystore** and registers the
public key; every later login is passwordless. A1's `SessionStore.token` stays
the session store; A2 removes the password from the later logins, not the token.

**Contract (server: `apps/api/src/device-auth.js` + `routes/device-auth.ts`)**

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/device/register` | bearer (driver) | bind this device's SPKI public key; stores public key only |
| POST | `/api/auth/device/challenge` | public | issue a single-use nonce (`ES256`, TTL 120 s, per-IP rate-limited) |
| POST | `/api/auth/device/verify` | public | signature over the nonce -> the same session token shape as a password login |
| POST | `/api/auth/device/revoke` | bearer (the credential's driver, or a **same-org** `user:manage`/`trip:*`) | lost-phone / logout revoke |

The device signs the **UTF-8 bytes of the nonce string** and sends a detached
DER ECDSA signature (`SHA256withECDSA`); the server verifies with
`crypto.verify('sha256', …, { dsaEncoding: 'der' })`. `DeviceCredential` stores
`publicKey` (base64 SPKI), `algorithm`, `deviceLabel`, `createdAt`,
`lastUsedAt`, `revokedAt` — never a private key and never a token.
`DeviceChallenge` is single-use (`usedAt`) with a short expiry, so a replayed
nonce can never open a second session; the burn is a **conditional** (`usedAt:
null`) update, so concurrent verifies of one challenge mint exactly one token.

**Threat notes**

- *Stolen server data:* only public keys and nonces are stored; they cannot be
  used to sign, so the dump does not authenticate anyone.
- *Replay:* `usedAt` + `expiresAt` make every challenge one-shot and short-lived.
- *Wrong key:* verification fails unless the signature matches the registered
  SPKI key — a second device's key cannot verify the first device's session.
- *Key extraction:* the private key is generated in the Keystore and used
  through `Signature.initSign`; no private bytes ever enter the process heap or
  logs (StrongBox when the SoC has it, TEE otherwise).
- *Curve:* only P-256 (`prime256v1`) keys are accepted — ES256 does not mean
  "any EC curve", so P-384/secp256k1 keys are refused at registration and never
  verify.
- *Cross-org:* roles are global (`Role.id` = owner/dispatcher/...), so `revoke`
  additionally requires the credential's driver to share the caller's non-null
  org; an admin in org A can never revoke a device in org B.
- *No account lockout on `verify` (deliberate):* unlike `/auth/login`, `verify`
  does not enforce `user.lockedUntil`. A password is guessable and needs that
  lockout; the device private key is not, and locking a phone out of its own key
  would strand the legitimate owner — the lost-phone remedy is revoking the
  credential, not locking the account.
- *No enumeration / no probing:* `challenge` and `verify` are rate-limited per
  real client IP, and `verify` returns a flat `invalid_signature`.
- *Lost phone:* `revoke` sets `revokedAt`; a revoked credential is refused at
  `challenge` (403) and at `verify` (403), and re-binding happens on the new
  device after a password/OTP login.

**Keystore fallback.** `KeystoreDeviceKeyMaterial` returns `null` when the
Keystore is unavailable (device without a secure element, or a generation
failure): `DeviceAuth.register/authenticate` then surface
`DeviceAuth.KEYSTORE_UNAVAILABLE` and the UI must fall back to the ordinary
password/OTP login. A device that cannot create a key is never locked out.

**Lost-phone revoke path (operator).** The driver (or an owner/`user:manage`)
calls `POST /api/auth/device/revoke { credentialId }`; it is idempotent, so the
call can be retried. After revocation the next `challenge` for that credential
is refused and the driver signs in on the replacement device with
password/OTP, which registers a fresh credential.

## 9b. Driver phases and live tracking (A3, board #105)

A3 extends the one state machine with the driver-facing phases and makes
**Start Trip** the gate that turns live GPS tracking on:

```
ASSIGNED → EN_ROUTE (Start Trip) → AT_PICKUP → LOADED → IN_TRANSIT
         → AT_DELIVERY → DELIVERED → POD_UPLOADED
```

- `:core` mirrors the phases in `model/TripStatus.kt` (`TRANSITIONS`,
  `START_TRIP_STATUS`, `ACTIVE_ASSIGNMENT_STATUSES`, `nextPhase`). The server
  machine in `apps/api/src/trip-status.js` stays authoritative and
  `TripCoreTest` pins the two.
- The trips screen renders the next driver phase as the **primary** action
  (filled button) and the remaining legal moves (the legacy jump, the
  `CANCELLED` escape hatch) as secondary buttons. For an `ASSIGNED` trip the
  primary action is **Start Trip**.
- Start Trip is not a generic status change: it is queued as `OutboxKind.START`
  and replayed against the dedicated `POST /api/trips/:id/start`, which sets
  `Trip.tracking = true` and stamps `trackingStartedAt` server-side. The app
  never invents the boolean; `DELIVERED` clears it on the server.
- The API refuses to double-book a driver (`409 driver_busy`); the app surfaces
  that as a rejected queue item like any other permanent (`4xx`) failure.

A4 (GPS upload) reads the `tracking` gate rather than inventing its own.

## 10. CI-first development (why there is no local build here)

The estate has no usable local Android toolchain: `dl.google.com/android/
repository/**` and `maven.google.com/**` return HTTP 404 from the pilot host, no
JDK/SDK is installed, and Debian's `android-sdk` is API 28 (2018). The Team
Leader's ruling (`#103`, 2026-10-01) is therefore **CI-first**: GitHub-hosted
runners carry Temurin 17 + the Android SDK + full network, and the acceptance
criterion is "repo CI builds the APK" anyway.

`.github/workflows/android-release.yml` builds `./gradlew --no-daemon
assembleDebug` for any PR touching `apps/android/**` and uploads the APK as the
`android-release` artifact. The wrapper's `gradle-wrapper.jar` **is tracked** —
the workflow gate is the existence of `apps/android/gradlew`, and the root
`.gitignore` deliberately does not exclude `*.jar`. `.github/workflows/**` is a
protected path; no A1 change touches it.

## 11. Consequences and follow-ups

- A1 ships one `:app` + one `:core`; the six target modules are a mechanical
  extraction as features land. A2 and A3 can work in parallel in `session/`+new
  auth code and in the trip-status mirror + new tracking package.
- The trip-status mirror must be extended **with** the server machine in A3 —
  two state machines are not allowed to drift (`TripCoreTest` pins the pairs).
- Room's `exportSchema` is off in A1; the first schema change turns it on.
- Open: the Play Data Safety wording (OPS1/owner), the exact tracking upload
  batching (A4), and the v4 menu set (`#110`/`#112`).
