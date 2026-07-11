// geist Quest 3 client — Gradle settings.
//
// Single module (`:app`) for the Phase 31 foundation skeleton. Meta Spatial SDK
// panel rendering + ray-cast wiring land in Phase 32 (M0 — spike: panel + ray).
// See .planning/specs/geist-spec.md §8 for the locked repo layout; this project
// is NOT an npm workspace (no package.json anywhere under quest/, and it is not
// listed in root package.json's `workspaces` array).

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
        // TODO(Phase 32): add Meta's Spatial SDK Maven repository (requires credentials).
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // TODO(Phase 32): add Meta's Spatial SDK Maven repository (requires credentials).
    }
}

rootProject.name = "geist-quest"

include(":app")
