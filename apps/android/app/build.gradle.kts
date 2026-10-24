// :app — the RoadwiseFleet driver application (board #103, AND1-A1).
import org.gradle.api.tasks.testing.Test

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Firebase Cloud Messaging is wired in, but the Google Services plugin is only
// applied when the operator drops the (non-secret) client config in place. That
// keeps the scaffold building on CI with no Firebase project, while making the
// config a drop-in later. The FCM runtime registration itself lives in
// PushRegistrar and degrades to "push disabled" if Firebase is not initialised.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    // The Kotlin package stays com.elilaltd.roadwisefleet.driver: the Play
    // identity is the applicationId, not the namespace (board #122).
    namespace = "com.elilaltd.roadwisefleet.driver"
    compileSdk = 36

    defaultConfig {
        // Board #122: the Play Console has exactly one app, com.roadwisefleet.
        // An upload whose applicationId differs is rejected as a new app.
        applicationId = "com.roadwisefleet"
        // Android 7.0: the cheapest handsets the pilot drivers carry still run
        // it; the app targets the current SDK for Play policy compliance
        // (Android 16 / API 36 is the Play target-API floor from 2026-08-31).
        minSdk = 24
        targetSdk = 36
        // Board #131: Play rejects an upload whose versionCode does not increase,
        // and the owner could not tell builds apart on the phone when every
        // handover carried 1 / "0.1.0-a1". Scheme: versionCode is a monotonic
        // integer incremented once per handed-over build; versionName is
        // <major>.<minor>.<patch>-a<build>, where a<n> tracks the same counter
        // (a1 = the 2026-10-19 scaffold handover, a2 = this build).
        versionCode = 2
        versionName = "0.2.0-a2"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // The API the driver app talks to. Overridable per build; never a secret.
        buildConfigField("String", "API_BASE_URL", "\"https://roadwisefleet.com\"")
        buildConfigField("String", "LOCALE_ASSET_DIR", "\"locales\"")
        // Board #125: WhatsApp OTP is hidden unless the provider is ready
        // (#124). Enable per build with -Proadwisefleet.whatsappOtp=true.
        val whatsappOtp = (project.findProperty("roadwisefleet.whatsappOtp") as String?) ?: "false"
        buildConfigField("boolean", "WHATSAPP_OTP_ENABLED", whatsappOtp)
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    // Board #114 (AND1-QA2): Robolectric/Compose Tier-2 suites need the merged
    // Android resources. The suites stay UNRUN until the CI job #113 lands.
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

// Board #122: Robolectric only supports Android 16 (SDK 36) on Java 21 — its
// `android-all-instrumented-16-robolectric-…` jar is compiled for 21 and
// DefaultSdkProvider refuses it on older runtimes ("Failed to create a
// Robolectric sandbox: Android SDK 36 requires Java 21"). The build itself stays
// on the Java 17 target above; only the test JVM is launched on a 21 toolchain,
// provisioned by the foojay resolver declared in settings.gradle.kts.
tasks.withType<Test>().configureEach {
    javaLauncher.set(
        javaToolchains.launcherFor {
            languageVersion.set(JavaLanguageVersion.of(21))
        }
    )
}

dependencies {
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)

    implementation(libs.kotlinx.coroutines.android)

    // Board #106 (AND1-A4): FusedLocation sampling in the foreground tracking
    // service, and WorkManager for the batched flush/retry of the offline queue.
    implementation(libs.play.services.location)
    implementation(libs.androidx.work.runtime.ktx)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)

    // Board #114 (AND1-QA2): Tier-2 test dependencies (hand-off from #108).
    // UNRUN until the CI instrumented job #113 lands; nothing here changes the
    // debug build. kotlinx-coroutines-test comes from the existing catalog
    // (1.9.0) to match the module's coroutines version, not the README's 1.8.1.
    // 4.16.1, not 4.14.1: board #122 moved targetSdk to 36 and Robolectric added
    // SDK-36 support in 4.16; an older DefaultSdkPicker rejects targetSdkVersion
    // > its max SDK ("Package targetSdkVersion=36 > maxSdkVersion=35").
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.work:work-testing:2.9.1")
    testImplementation(libs.kotlinx.coroutines.test)

    // Compose test artifacts stay versionless: the same BOM the app already uses
    // (libs.androidx.compose.bom) aligns them. No new repositories.
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.compose.ui:ui-test-manifest")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
