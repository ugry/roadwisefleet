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
