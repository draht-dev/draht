package dev.draht.geist.panel

import dev.draht.geist.input.PanelSurface
import dev.draht.geist.input.Plane
import dev.draht.geist.input.Vec3

/**
 * Placeholder pose for a panel in world space: a position, the outward-facing
 * normal (the direction it faces the wearer, panel-local +Z by convention),
 * and the panel's physical size in meters. Real pose data comes from the
 * Spatial SDK's SceneObject transform once panels are actually registered
 * (see [PassthroughPanel.attach]) — this is the structural placeholder spec
 * §7's "layout" responsibility expects quest/ to own until then.
 */
data class PanelPose(
    val position: Vec3,
    val normal: Vec3 = Vec3(0f, 0f, 1f),
    val widthMeters: Float = 0.6f,
    val heightMeters: Float = 0.4f,
)

/**
 * One passthrough app panel — spec §3 ("Any URL as a passthrough panel"),
 * spec §7 quest/ row ("app panels"). At most [MAX_LIVE_PANELS] may be live
 * simultaneously (spec §6 locked stack: "board/detail/app WebViews, ≤3
 * live"); see [PanelRegistry], which MainActivity owns, for that cap
 * enforced across the active set.
 */
data class PassthroughPanel(
    val id: String,
    val sourceUrl: String,
    val pose: PanelPose,
    val alphaMode: PanelAlphaMode = PanelAlphaMode.default,
) {

    /**
     * Converts this panel's pose into the plane
     * [dev.draht.geist.input.resolveAddressee] ray-casts against — the
     * "ray→addressee" link between quest/'s panel and input layers (spec §7).
     */
    fun toPanelSurface(): PanelSurface = PanelSurface(
        panelId = id,
        plane = Plane(point = pose.position, normal = pose.normal),
        halfWidth = pose.widthMeters / 2f,
        halfHeight = pose.heightMeters / 2f,
    )

    /**
     * Attaches this panel to the live scene and starts rendering [sourceUrl]
     * as a passthrough panel. Not implemented in this sandbox scaffold — the
     * real call registers a Spatial SDK panel SceneObject (Panel component +
     * WebView/URL surface binding) at [pose], honoring [alphaMode]'s
     * material description.
     *
     * TODO(Phase 32 hardware bring-up): call the real Meta Spatial SDK panel
     * registration API (SceneObject creation, Panel component attachment,
     * WebView/URL surface binding) once Maven access to the SDK is
     * available. The exact API surface (class/builder names) is not known
     * from this sandbox and is deliberately not guessed at — see
     * .planning/specs/geist-spec.md §6/§7 and the Spatial SDK docs at
     * hardware bring-up time.
     */
    fun attach() {
        // Intentionally unimplemented — see the TODO above. This method
        // exists so PanelRegistry/MainActivity has a real lifecycle hook to
        // call once Phase 32 hardware bring-up lands the actual SDK call.
    }

    /**
     * Detaches this panel from the scene, releasing its Spatial SDK
     * resources (inverse of [attach]).
     *
     * TODO(Phase 32 hardware bring-up): call the real Meta Spatial SDK panel
     * teardown API.
     */
    fun detach() {
        // Intentionally unimplemented — see the TODO above.
    }

    companion object {
        /** Spec §6: "board/detail/app WebViews, ≤3 live." */
        const val MAX_LIVE_PANELS = 3
    }
}

/**
 * Holds the set of currently active [PassthroughPanel]s, enforcing the ≤3
 * live-panel cap (spec §6) and exposing their ray-cast surfaces for
 * addressee resolution. MainActivity owns one instance of this and delegates
 * panel lifecycle to it, keeping MainActivity's own body minimal.
 */
class PanelRegistry {
    private val panels = mutableListOf<PassthroughPanel>()

    /** Snapshot of currently active panels. */
    val active: List<PassthroughPanel>
        get() = panels.toList()

    /**
     * Attaches [panel] and adds it to the active set.
     *
     * @throws IllegalStateException if adding [panel] would exceed the ≤3
     * live-panel cap (spec §6).
     */
    fun add(panel: PassthroughPanel) {
        check(panels.size < PassthroughPanel.MAX_LIVE_PANELS) {
            "cannot exceed ${PassthroughPanel.MAX_LIVE_PANELS} live panels (spec §6)"
        }
        panel.attach()
        panels.add(panel)
    }

    /** Detaches and removes the panel with [panelId], if one is active. */
    fun remove(panelId: String) {
        val panel = panels.find { it.id == panelId } ?: return
        panel.detach()
        panels.remove(panel)
    }

    /**
     * Ray-cast surfaces for every active panel — feeds
     * [dev.draht.geist.input.resolveAddressee] to resolve which panel a ray
     * (controller/hand pose at PTT press) is addressing.
     */
    fun surfaces(): List<PanelSurface> = panels.map { it.toPanelSurface() }
}
