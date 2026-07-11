// geist Quest 3 client — root Gradle build file.
//
// See .planning/specs/geist-spec.md §5/§6/§8 for the locked stack (Kotlin + Meta
// Spatial SDK, Meta-Spatial-SDK pinned at M0). This is Phase 31 (foundation) scaffold
// only: this sandbox has no gradle/kotlinc on PATH, no Quest hardware, and no Meta
// Spatial SDK Maven credentials, so nothing here has been build/run-verified.
// Structurally correct, not build-verified; Phase 32 (M0) does the real panel +
// ray-cast spike on top of this skeleton.

plugins {
    // `apply false` here: each module applies (and version-resolves) what it needs —
    // see app/build.gradle.kts.
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}

// TODO(Phase 32): pin Meta Spatial SDK dependency + Maven repo credentials.
