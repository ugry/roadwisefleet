# Android release — signing, Google Play distribution, FCM (board #109 / AND1-OPS1)

Scope: the **release** pipeline for `apps/android/`. The app scaffold itself
(board #103, A1) and the device-auth/Keystore work (#104, A2) are software
development; the debug build job is Max's, in `ci.yml`. This runbook and
[`checks/android-release-check.sh`](./checks/android-release-check.sh) own the
three credentials AND1-OPS1 introduces and the CI that consumes them.

Owner decision (recorded on board #109, Matrix 2026-10-01): **Google Play —
internal testing first, then production.** The one-off Play registration fee is
paid by the owner.

## 0. Status (2026-10-01)

| Item | State |
| --- | --- |
| Release workflow `.github/workflows/android-release.yml` | **in the repo**; a no-op until `apps/android/gradlew` exists (it builds nothing before A1 lands) |
| Secret-hygiene guard + CI job | **in the repo and green on fixtures** |
| Keystore | **not generated** — operator step (§2); must never enter git |
| Play Console account + service account | **not created** — owner step (§4) |
| FCM project + server credential | **not created** — owner step (§5) |
| Data Safety / background-location declaration | **draft only** (§6) |
| Signed build produced by CI | **not demonstrated** — needs the scaffold + the four signing secrets |

Nothing here is installed on a host: this is entirely repo-side CI plus operator
steps. No credential value appears in this file.

## 1. The secret-name contract

The release workflow and this runbook must agree on these names; the guard fails
CI if one is renamed without the other. Values live **only** in GitHub
(Actions secrets / the `google-play` environment) and, for the operator backup,
in the owner's secrets store.

| Name | Kind | Used for |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Actions secret | the release keystore, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | Actions secret | keystore (store) password |
| `ANDROID_KEY_ALIAS` | Actions secret | key alias inside the keystore |
| `ANDROID_KEY_PASSWORD` | Actions secret | key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | `google-play` environment secret | Play Developer API upload |

## 2. The release keystore

Generate it **once**, on a trusted machine (not in CI, not in this sandbox), and
never commit it. The `keytool` command (Java 17):

```bash
keytool -genkeypair -v \
  -keystore release.jks -alias roadwisefleet \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype JKS
# then, for the CI secret only:
base64 -w0 release.jks   # paste into the ANDROID_KEYSTORE_BASE64 secret
```

Custody:

- The `.jks` and its passwords go into the **owner's secrets manager** and an
  operator-held offline backup. Losing the upload key means a Play support
  request to reset it; losing the app-signing key (when Play App Signing is
  enabled) is unrecoverable, which is exactly why Play App Signing is the
  default here.
- `.gitignore` already refuses `*.jks`, `*.keystore`, `*.p12`,
  `keystore.properties` and `service-account*.json`; the guard proves it.
- Rotation: with Play App Signing the **upload key** can be reset in the Play
  Console without touching the app-signing key. Record the reset in this file
  when it happens.

## 3. The CI pipeline

`.github/workflows/android-release.yml`:

- **Triggers:** `workflow_dispatch` (with a `track` choice), tags `android-v*`,
  and PRs that touch `apps/android/**` or the workflow itself.
- **Gate:** the build job runs only when `apps/android/gradlew` exists, so it is
  a clean skip until A1 lands and can never redden CI before then.
- **Signing:** the keystore is decoded from `ANDROID_KEYSTORE_BASE64` into the
  runner temp dir, consumed via AGP's injected-signing properties, and deleted
  in an `always()` step. When the four secrets are absent the job builds an
  unsigned debug APK and emits a warning instead of failing (fork PRs never see
  secrets).
- **Artifacts:** every `*.aab` and `*.apk` under `apps/android/**/build/outputs/`
  is uploaded as `android-release` (14-day retention).
- **Publish:** the `publish` job is `workflow_dispatch`-only, requires the
  `google-play` environment, and uploads the AAB to the chosen track.

Verify a signed build:

```bash
gh run list --repo ugry/roadwisefleet            # find the android-release run
gh run view <run-id> --repo ugry/roadwisefleet   # jobs: build (+ publish)
# locally, on a downloaded artifact:
keytool -printcert -jarfile app-release.apk      # shows the signer CN
```

## 4. Google Play — internal testing, then production

Owner/operator steps (I hold no Play account and no ability to create one):

1. **Play Console account** — owner, one-off registration fee (owner stated
   EUR 25; Google charges USD 25, receipt confirms).
2. **App entry** — package `com.elilaltd.roadwisefleet.driver`; app id pairs
   with board #104's device-auth work.
3. **Play App Signing** — accept it; the CI keystore is then the *upload* key.
4. **Service account** — Google Cloud project → enable the *Google Play Android
   Developer API* → create a service account → download its JSON key → grant it
   "Release to testing tracks" for the app. Store the JSON only as the
   `PLAY_SERVICE_ACCOUNT_JSON` environment secret; never in the repo. This key
   carries a `private_key` field — the guard's content scan fails the build if
   such a file is ever committed.
5. **Data Safety form + background-location declaration** (§6) must be complete
   before the first production release.
6. **First upload** — run the workflow with `track: internal`, install from the
   internal-testing link on a device, confirm a push arrives (§5), then promote
   `internal → production` deliberately (the workflow accepts `track:
   production` but does not promote by itself).

## 5. FCM credentials

- The **client** config (`google-services.json`) ships with the app; it is
  client configuration, not a server secret, and is allowed in the repo (the
  guard only warns if it appears). It carries no server key.
- The **server** credential is what sends pushes. Use the FCM **HTTP v1** API
  (the legacy server key is deprecated): a Google service-account JSON with the
  *Firebase Cloud Messaging API* enabled. It is stored on the pilot host beside
  the other secrets — a 0600 env/file referenced from the service unit, key
  names only in this file. It must never appear in the repo or in a workflow
  log; the same content scan as §4 catches it.
- Wiring the sender belongs to the notification transport (board #79): FCM is a
  new channel behind the same envelope, not a second delivery path. The board
  #79 runbook owns that contract.

## 6. Play Data Safety + ACCESS_BACKGROUND_LOCATION (draft)

Draft only — the owner/product/legal sign-off is an open decision (§9). Play
requires, for a 10-minute background location foreground service:

- **Data Safety:** declare *Precise location* collected (app functionality,
  not advertising), *linked to the user*, encrypted in transit, deletable on
  request; declare account data (name, email, phone) and documents (POD/eCMR)
  the same way. Nothing here may be marked "not collected".
- **Background location:** a written justification that tracking runs **only
  while a trip is active** (the driver's Start Trip button; it stops at
  DELIVERED) and the battery constraint the owner recorded, plus a **demo
  video** showing the prominent disclosure and the foreground-service
  notification. Tracking outside an active trip is not requested.
- **Permissions to declare:** `ACCESS_FINE_LOCATION`,
  `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`.

## 7. Guard + CI job

`checks/android-release-check.sh`:

- `--self-test` proves each rejection (a tracked keystore, a private key under
  an innocent filename, a `.gitignore` gap, an inline base64 blob, a signing
  value taken from `vars` instead of `secrets`, an ungated workflow, a missing
  workflow).
- Repo mode is the CI gate: no signing material by name or content, `.gitignore`
  coverage, and a gated / least-privilege / secrets-only release workflow whose
  secret names match this file.

CI job `android-release-check` in `ci.yml` (self-test + repo check).

## 8. Acceptance mapping (honest)

| #109 acceptance | State |
| --- | --- |
| a signed build is produced by CI | **NOT met** — needs the A1 scaffold + the four signing secrets; the workflow is wired and guarded but has produced nothing |
| the chosen channel accepts it | **NOT met** — needs the Play account + service account (§4) |
| FCM delivery verified on a test device | **NOT met** — needs the FCM project (§5), the app, and a device |
| the Data Safety draft is ready for the owner | **draft skeleton only** (§6) |

## 9. Open decisions / owner inputs

1. Who owns the Play Console account and the EUR/USD 25 one-off (owner said he
   pays; the payer identity is confirmed from the receipt).
2. The service account for the Play API — created by the owner, shared as the
   `PLAY_SERVICE_ACCOUNT_JSON` secret.
3. The FCM/Firebase project (owner) and where its server credential will live on
   the pilot host.
4. Product/legal sign-off on the Data Safety + background-location declaration.
5. Confirmation that AGP's injected-signing properties fit A1's Gradle setup;
   if A1 prefers an app-side `signingConfig`, the workflow's `-P` flags are
   redundant but harmless, and this file is updated.
