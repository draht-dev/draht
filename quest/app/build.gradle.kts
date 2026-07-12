// geist Quest 3 client — `:app` module build file.
//
// Foundation skeleton (Phase 31): applies the Android + Kotlin plugins and declares a
// single entry-point activity (MainActivity.kt). Meta Spatial SDK panel rendering and
// ray-cast addressee resolution are Phase 32 (M0) scope — not implemented here.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.draht.geist"

    // minSdk/targetSdk/compileSdk below are placeholders, not confirmed against Meta
    // Quest 3's current Spatial SDK requirements (no Meta SDK docs/Maven access in this
    // sandbox). Confirm against Meta's published minimums before the first real build.
    // TODO(Phase 32): confirm compileSdk/minSdk/targetSdk against Meta Spatial SDK requirements.
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.draht.geist"
        minSdk = 29 // placeholder — TODO(Phase 32): confirm Quest 3 / Spatial SDK minimum
        targetSdk = 34 // placeholder — TODO(Phase 32): confirm against Meta Spatial SDK requirements
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.0")
    // TODO(Phase 32): pin Meta Spatial SDK dependency (see root build.gradle.kts note).
}
