package dev.draht.geist

import android.os.Bundle
import androidx.activity.ComponentActivity
import dev.draht.geist.panel.PanelRegistry

/**
 * geist Quest 3 client — app entry point.
 *
 * Phase 32 (M0 — spike: panel + ray; see .planning/specs/geist-spec.md §7/§16) scope:
 * this class owns a [PanelRegistry] (≤3 live panels, spec §6) and delegates panel
 * lifecycle to it and ray→addressee resolution to dev.draht.geist.input.RayCast — both
 * are structurally real, SDK-independent Kotlin. Real Meta Spatial SDK scene/session
 * setup (the immersive activity base, scene graph creation, etc.) is still Phase 32
 * hardware bring-up; see PassthroughPanel.attach()'s TODO for the exact call site this
 * class will need once Maven access to the SDK exists.
 */
class MainActivity : ComponentActivity() {

    /** Active app panels (spec §7: "app panels"), capped at ≤3 live (spec §6). */
    private val panels = PanelRegistry()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Real Spatial SDK session/scene setup is Phase 32 hardware bring-up (no SDK
        // Maven access in this sandbox); see PassthroughPanel.attach()'s TODO. `panels`
        // is ready to receive PassthroughPanel instances, and its surfaces() feed
        // dev.draht.geist.input.resolveAddressee(), once that scene exists.
    }
}
