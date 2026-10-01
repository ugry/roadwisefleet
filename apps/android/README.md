# RoadwiseFleet driver app (`apps/android/`)

Native Android driver app — Kotlin + Jetpack Compose, package
`com.elilaltd.roadwisefleet.driver`. This directory is the **A1 scaffold**
(board `eila/tasks#103`, epic `#102`): the shell, the offline store, the sync
engine and the i18n wiring that A2–A5 build on.

Architecture, the module map, the offline model, distribution and signing
ownership: [`docs/android-architecture.md`](../../docs/android-architecture.md).

## Modules

| Module  | What lives here |
| ------- | --------------- |
| `:app`  | Application, navigation, the 5-tab one-thumb shell, SOS, FCM wiring, manual DI container. |
| `:core` | UI-free: trip-status mirror, capture rules, outbox planner, Room store, sync engine, API client, i18n catalogues. |

## Build

The estate has no local JDK/Android SDK (see the ADR), so **CI is the build
source of truth**. `.github/workflows/android-release.yml` builds
`./gradlew --no-daemon assembleDebug` for any PR touching `apps/android/**` and
uploads `apps/android/app/build/outputs/apk/debug/app-debug.apk` as the
`android-release` artifact.

On a machine that does have a toolchain (JDK 17 + Android SDK):

```sh
cd apps/android
./gradlew --no-daemon assembleDebug   # debug APK
./gradlew --no-daemon test            # JVM unit tests (:core domain rules)
```

## i18n

The four catalogues under `core/src/main/assets/locales/` are byte-identical
copies of `pilot/locales/{en,de,pl,tr}.json` (board task #6), so a key the app
uses always has the pilot's translation. `tools/check-locales.mjs` proves the
copies have not drifted and that the four catalogues share one key set:

```sh
node apps/android/tools/check-locales.mjs
```

## Secrets

None. Signing material, the Play service-account key and the FCM server
credential live only in GitHub secrets (`infra/android-release.md`); the FCM
`google-services.json` client config is optional and never this repo's concern
(the guard is `infra/checks/android-release-check.sh`).
