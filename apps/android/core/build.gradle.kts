// :core — domain, offline store, sync engine, API client and i18n
// (board #103, AND1-A1). Deliberately UI-free and Firebase-free: the app module
// owns Compose and FCM, so the domain rules stay unit-testable on the JVM.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.elilaltd.roadwisefleet.core"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = false
    }

    // Board #114 (AND1-QA2): Robolectric/Room Tier-2 suites need the merged
    // Android resources. The suites stay UNRUN until the CI job #113 lands.
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines.android)

    // `api`, not `implementation`: :app holds RoadwiseDatabase and therefore
    // needs RoomDatabase on its compile classpath.
    api(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    // Board #114 (AND1-QA2): Tier-2 JVM test dependencies (hand-off from #108).
    // UNRUN until the CI instrumented job #113 lands. room-testing matches the
    // Room 2.6.1 already declared above.
    // 4.14.1, not 4.13: Robolectric added SDK-35 support in 4.14 and this module
    // follows :app on compileSdk 35.
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.room:room-testing:2.6.1")
}
