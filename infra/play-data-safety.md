# Play Data Safety + background-location declaration (board #109)

Status: **draft complete, submission-ready except for two Play-required public
URLs that do not exist yet** (§5). Owner/legal sign-off is still required (§9) —
this file records what the product actually does; it is not legal advice.

Provenance: every "collected" row below is derived from the code at `main`
`577a5281f86d4f5993a4320a5df4a0be573655ee` (2026-10-18) by reading
`apps/android/app/src/main/AndroidManifest.xml`, `apps/android/app/build.gradle.kts`,
`apps/android/app/src/main/java/**` and `prisma/schema.prisma`. The live probe in
§5 was made from elilavps2 on the same date. Rows that the code cannot prove are
marked **owner/legal decision** rather than guessed.

The permission block in §8 is machine-checked against the manifest by
`infra/checks/play-data-safety-check.sh` (CI job `play-data-safety`), so the next
permission the app adds — the POD camera is the known one (A4 follow-up) — cannot
ship without this declaration changing in the same PR.

---

## 1. Scope

The Play form describes the **Android driver app**
(`com.elilaltd.roadwisefleet.driver`). The web surfaces (`/pilot/`, `/app/`,
`/c/`, `/s/`) are not part of the APK's declaration, but they hit the same
backend and the same database; §4 records where the data is stored so the privacy
policy (§5, B-P1) can describe both.

Transport: the app talks only to `https://roadwisefleet.com` (`API_BASE_URL`,
`apps/android/app/build.gradle.kts`). There is no cleartext endpoint, no third-party
endpoint and no ad/analytics/ crash SDK in the build (§3).

## 2. Data Safety answers (the form's per-data-type table)

"Collected" = transmitted off the device by the app. "Shared" follows Play's
definition (transfer to a third party); Google Firebase Cloud Messaging processes
the push token and message payload as our **service provider**, which the form's
guidance excludes from "shared" — confirm the wording in the console at submission
(§9 item 4).

| Play data type | Collected | Shared | Purpose | Optional? | Linked to identity | Encrypted in transit | Deletable | Code evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Location → Approximate location | Yes | No | App functionality (active-trip tracking) | Required for the driver role; sampled **only** while a trip is active | Yes (trip → driver) | Yes | Yes, on request (§5 B-P2) | `ACCESS_COARSE_LOCATION`; `GpsPing.lat/lng` |
| Location → Precise location | Yes | No | App functionality (route + POD capture position) | Required (`ACCESS_FINE_LOCATION`) | Yes | Yes | Yes, on request | `ACCESS_FINE_LOCATION`; `GpsPing.accuracyM`, `Document.captureLat/Lng` |
| Personal info → Name | Yes | No | Account management, app functionality | Required for the account | Yes | Yes | Yes, on request | `User.name` |
| Personal info → Email address | Yes | No | Account management, notifications | Required where an email is the login | Yes | Yes | Yes, on request | `User.email` (unique, nullable) |
| Personal info → Phone number | Yes | No | Account management, notifications (WhatsApp/SMS when enabled) | Optional | Yes | Yes | Yes, on request | `User.phone` (nullable) |
| Personal info → User IDs | Yes | No | Account management, authentication | Required | Yes | Yes | Yes, on request | `User.id`, `DeviceCredential.publicKey` |
| App activity → Other actions | Yes | No | App functionality (trip status events, audit trail) | Required | Yes | Yes | Yes, on request | `StatusEvent`, `AuditLog` |
| Device or other IDs | Yes | No | App functionality (push delivery, passwordless device auth) | Required | Yes | Yes | Yes, on request | FCM registration token (`PushRegistrar`); Android Keystore public key (`KeystoreDeviceKeyMaterial`) |
| Photos and videos → Photos | **Not yet** — this build declares no `CAMERA` permission | — | App functionality (POD / eCMR evidence) when A4 capture lands | Required once it lands | Yes | Yes | Retention policy pending (#46) | `Document` (`docType` `pod`/`ecmr`), `captureLat/Lng`, `captureAccuracyM` |
| Files and docs → Files and docs | **Not yet via the app** (uploads today go through the web/pilot surface) | — | App functionality | — | Yes | Yes | Retention policy pending (#46) | `Document.storageKey` |

Everything above is declared **required** for the driver role except the phone
number. The app has no advertising, no marketing use and no profiling; no data
type is collected for "Advertising or marketing" or "Analytics".

## 3. Not collected (verified, not assumed)

The Data Safety form must not be marked "not collected" for the rows in §2 — but
these are genuinely absent and can be answered "No":

- **Analytics, crash logs/diagnostics, advertising or marketing**: no such SDK is
  declared or depended on — `grep -rniE 'analytics|crashlytics|sentry|amplitude|mixpanel|appsflyer' apps/android`
  returns nothing (run 2026-10-18 against `main`).
- **Contacts, SMS/MMS, call logs, calendar, health, financial/payment info,
  browsing history, installed apps**: no permission and no API use; the manifest
  declares only the nine permissions in §8.
- **Microphone, camera, files/photos read access**: not declared in this build.

Re-run the grep and the manifest comparison when a dependency or permission
changes; CI does the second half automatically (§8).

## 4. Security practices (the form's "Security practices" section)

- **Data encrypted in transit** — yes. The only base URL is
  `https://roadwisefleet.com`; the app targets SDK 35, where cleartext traffic is
  off by default, and no `usesCleartextTraffic` / network-security-config exception
  exists.
- **You can request that data be deleted** — the *mechanism* must exist before
  this can be answered "yes" (§5 B-P2). Today the answer would be **no**, which is
  a submission blocker.
- **Data is not transferred to other companies** — no third-party SDK; FCM is a
  service provider (see §2).
- **Independent security review** — no.
- **Data stored on device**: the bearer session token and locale live in
  app-private `SharedPreferences` (`SessionStore`), the offline GPS queue in
  app-private WorkManager/cache storage, and the device signing key in the Android
  Keystore (the private key never leaves it). `android:allowBackup="false"`, so no
  backup carries these off the device. The session token is app-private but not
  additionally encrypted at rest — defence-in-depth opportunity, not a Play
  requirement; noted for Max.

## 5. Play requirements this task cannot answer yet (release blockers)

**B-P1 — privacy policy URL.** Play requires a privacy policy for an app that
requests sensitive permissions. No page exists: `curl -sI
https://roadwisefleet.com/privacy` → **404** (2026-10-18). Needs: owner/legal text,
a published URL, and that URL entered in the console. Also needed by the Data
Safety form itself.

**B-P2 — account deletion.** Play requires apps that let users create accounts to
offer **in-app deletion** *and* a **web deletion-request URL**. Neither exists:
`grep -rn "delete" apps/api/src/routes` finds address/bookmark/beacon/track-link
deletion only — no user or account deletion route. Needs: Max (API endpoint +
in-app entry point), owner (public request URL), and a retention carve-out that
does not contradict #46 (documents/trip records may have to outlive the account;
that is exactly the owner+legal decision on #46, and the deletion flow must state
it).

**B-P3 — Data Safety sign-off.** The answers in §2 are derived from code but the
declaration is a legal statement made by the developer account holder.

**B-P4 — background-location demo video.** Google requires a short screen
recording for `ACCESS_BACKGROUND_LOCATION`. I hold no device and no camera; the
operator records it to §7.3's shot list.

None of B-P1..B-P4 is a code change I can make in this lane; each is routed in
§9.

## 6. Permissions declared in the Play listing

The form's "Sensitive permissions" section mirrors the manifest. The manifest is
the source of truth (§8); this list is what the console should show:

`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`,
`FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS` — plus the non-sensitive
`INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `RECEIVE_BOOT_COMPLETED`.

## 7. Background location declaration

### 7.1 Paste-ready justification

> RoadwiseFleet is a fleet operating system. The driver app tracks location
> **only while a trip is active**, and only for drivers: the dispatcher assigns a
> trip, the driver taps **Start Trip**, and tracking begins; the server ends the
> window at **DELIVERED** (or when the dispatcher turns tracking off) and the app
> stops the foreground service. Location is used to show the fleet and the
> customer's share link where the load is, to compute on-time/detention and to
> attach the capture position to proof-of-delivery evidence. Location is never
> collected outside an active trip, there is no always-on background location, no
> geofencing-based advertising and no sale or sharing of location data. The user
> sees a persistent foreground-service notification for the whole tracking window
> and can stop tracking by ending the trip; uninstalling the app or revoking the
> permission stops it immediately.

### 7.2 Prominent disclosure (in-app, before the system prompt)

Required properties: shown **before** the runtime permission dialog, not buried
in a list, with an explicit "continue/not now" choice. Draft copy:

> **Location while you are driving**
> RoadwiseFleet shares your vehicle's location with your dispatcher and the
> customer tracking link **only while a trip is active**. It starts when you tap
> Start Trip and stops when the trip is delivered. It is not used for advertising.
> You can turn this off — trips will then show no live position.

### 7.3 Demo-video shot list (60–90 s, no voice-over needed)

1. Install from the internal-testing link; open the app.
2. The prominent disclosure appears; tap **Continue**.
3. The system location dialog appears; choose **While using the app**, then the
   follow-up **Allow all the time** for background (this is the exact sequence
   Google's reviewers look for).
4. Tap **Start Trip**; pull down the notification shade and hold the
   foreground-service notification visible for a few seconds.
5. Show the trip moving on the map / the dispatcher view or the `/track/` link.
6. Complete the trip (**DELIVERED**); show the notification disappear and the
   location indicator stop.

## 8. Declared permissions (machine-checked against the manifest)

Keep this block in sync with `apps/android/app/src/main/AndroidManifest.xml`.
`infra/checks/play-data-safety-check.sh` fails CI if the two sets differ in either
direction, and if any line below loses its justification.

<!-- play-data-safety:permissions:start -->
- android.permission.INTERNET :: transport to https://roadwisefleet.com; no data type by itself
- android.permission.ACCESS_NETWORK_STATE :: offline GPS queue flush (WorkManager network constraint)
- android.permission.POST_NOTIFICATIONS :: trip/push notifications (FCM); no data type by itself
- android.permission.ACCESS_FINE_LOCATION :: precise location while a trip is active (§2, §7)
- android.permission.ACCESS_COARSE_LOCATION :: fallback location while a trip is active (§2, §7)
- android.permission.ACCESS_BACKGROUND_LOCATION :: keeps the active-trip window alive when the app is backgrounded (§7)
- android.permission.FOREGROUND_SERVICE :: hosts the location-typed tracking service
- android.permission.FOREGROUND_SERVICE_LOCATION :: API 34+ type declaration for that service
- android.permission.RECEIVE_BOOT_COMPLETED :: resumes an active trip after a reboot; does not start tracking on its own
<!-- play-data-safety:permissions:end -->

## 9. Owner / legal sign-off checklist

1. **Approve the §2 answer set** (in particular whether FCM counts as "shared"
   and whether invoice/trip amounts are "financial info" — this file treats them
   as business records, not user financial data).
2. **B-P1** privacy policy text + published URL.
3. **B-P2** account-deletion policy: what is deleted, what must be retained
   (documents/trip records — the #46 retention decision), and the public URL.
4. **B-P4** record the demo video to §7.3.
5. Confirm the Data Safety answers in the console match this file at submission
   time (the console wording changes between policy revisions).

Routed work, in the owner's hands: B-P1/B-P2 text and URLs (owner + legal),
B-P2 endpoint + in-app entry point (Max), B-P4 recording (operator).

## 10. Acceptance mapping for #109

| #109 acceptance | State |
| --- | --- |
| a signed build is produced by CI | **NOT met** — needs the four `ANDROID_KEYSTORE_*` secrets |
| the chosen channel accepts it | **NOT met** — Play API returns `404 Package not found` until the owner grants the service account "Release to testing tracks" |
| FCM delivery verified by receiving a push on a test device | **NOT met** — needs the FCM project credential + a device |
| the Data Safety draft is ready for the owner | **draft complete** — §2/§7 written from code; blocked on B-P1/B-P2 (Play-required URLs) and the owner/legal sign-off in §9 |

Nothing in this file is installed or deployed; it is a document plus one CI check.
