// Root build file — every plugin is declared here with `apply false` so the
// versions are resolved once (the version catalog lives in
// gradle/libs.versions.toml). The Google Services plugin is on the classpath
// but applied conditionally by :app (only when google-services.json exists),
// so the scaffold builds on CI without any Firebase project configured.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.google.services) apply false
}
