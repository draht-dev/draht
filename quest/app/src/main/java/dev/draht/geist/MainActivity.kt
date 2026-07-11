package dev.draht.geist

import android.os.Bundle
import androidx.activity.ComponentActivity

/**
 * geist Quest 3 client — app entry point.
 *
 * Foundation skeleton only (GSD Phase 31 — R31-FOUND). Meta Spatial SDK scene setup,
 * panel rendering, and ray-cast addressee resolution are Phase 32 (M0 — spike: panel +
 * ray) scope; see .planning/specs/geist-spec.md §7/§16. This class intentionally does
 * nothing beyond satisfying the Android app entry-point contract until that work lands.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Spatial SDK panel + ray-cast wiring lands in Phase 32 (M0). Nothing to do yet.
    }
}
