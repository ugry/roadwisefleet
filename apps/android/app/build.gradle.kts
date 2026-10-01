// :app — the RoadwiseFleet driver application (board #103, AND1-A1).
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
    namespace = "com.elilaltd.roadwisefleet.driver"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.elilaltd.roadwisefleet.driver"
        // Android 7.0: the cheapest handsets the pilot drivers carry still run
        // it; the app targets the current SDK for Play policy compliance.
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-a1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // The API the driver app talks to. Overridable per build; never a secret.
        buildConfigField("String", "API_BASE_URL", "\"https://roadwisefleet.com\"")
        buildConfigField("String", "LOCALE_ASSET_DIR", "\"locales\"")
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
}
