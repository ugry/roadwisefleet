// RoadwiseFleet driver app — Gradle settings (board #103, AND1-A1).
//
// Two modules for A1:
//   :app  — the Android application: navigation, the 5-tab one-thumb shell,
//           SOS, FCM wiring and the manual DI container.
//   :core — an Android library: the domain mirror (trip-status), the Room
//           offline store, the sync engine, the API client and the i18n
//           catalogues. It carries no UI, so the domain stays testable.
//
// The target module map for A2+ (auth, tracking, QA) is in
// docs/android-architecture.md. Google's Maven repository is declared with
// content filters so the plugin classpath is resolved from Google + Maven
// Central only — the same two repositories the release workflow uses.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

// Board #122: Robolectric's Android 16 (SDK 36) runtime jar is compiled for
// Java 21, so :app's unit-test JVM needs a 21 toolchain even though the build
// itself runs on Java 17. The resolver lets Gradle provision it on CI runners
// that only install 17.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "RoadwiseFleetDriver"

include(":app")
include(":core")
