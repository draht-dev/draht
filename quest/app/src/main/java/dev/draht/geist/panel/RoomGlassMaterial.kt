package dev.draht.geist.panel

/**
 * The panel-alpha probe (spec §13, locked decision §17.6): "room-glass falls
 * back to opaque smoke if panel alpha disappoints at M0." Both code paths
 * below are implemented so a human running the real M0 spike on hardware can
 * flip [PanelAlphaMode.default] once the Spatial SDK's panel-alpha behavior
 * is actually measured on a Quest 3 — this sandbox cannot render or measure
 * panel alpha, so neither path is "chosen" here beyond a safe placeholder.
 *
 * Token values (hex, alpha) below are taken verbatim from
 * packages/geist-console/src/tokens.css (`--smoke-900`, `--spectra-a`,
 * `--spectra-b`) so the Kotlin panel chrome and the console agree without a
 * second source of truth (spec §13: "Kotlin panels match radii + alpha").
 */
sealed class PanelAlphaMode {

    /** One flat-color layer of a panel's material, described (not yet SDK-bound). */
    data class MaterialLayer(
        val colorHex: String,
        val alpha: Float,
        val description: String,
    )

    /**
     * room-glass (spec §13): alpha-composited smoke over real passthrough —
     * `smoke-900 @ ~78%`, fine noise, a specular top edge, and a 1px
     * dichroic hairline. "No blur claimed" — Quest apps cannot sample
     * passthrough (system-composited, by design), so this is honest alpha
     * compositing, not a blur/refraction effect.
     *
     * This is the state *attempted first* at the M0 probe; see
     * [OpaqueSmokeFallback] for the safe state the design falls back to.
     */
    data object RoomGlass : PanelAlphaMode() {
        /** `--smoke-900` from tokens.css, ~78% alpha per spec §13. */
        val backgroundLayer = MaterialLayer(
            colorHex = "#0b0d10", // --smoke-900
            alpha = 0.78f,
            description = "smoke-900 @ ~78% alpha-composited over passthrough",
        )

        const val NOISE_DESCRIPTION = "fine noise overlay, low amplitude — breaks up alpha banding over passthrough"
        const val SPECULAR_EDGE_DESCRIPTION = "specular highlight along the panel's top edge"
        const val HAIRLINE_DESCRIPTION = "1px dichroic hairline border (spectra-a → spectra-b gradient)"

        /** `--spectra-a` → `--spectra-b` gradient stops for the 1px hairline, per tokens.css. */
        val hairlineGradientHex = listOf("#6ee7f0", "#a78bfa") // --spectra-a, --spectra-b

        // TODO(Phase 32 hardware bring-up): bind this description to the
        // real Meta Spatial SDK panel material / alpha-blend-over-passthrough
        // API once its shape is known. Whether Spatial SDK panels can even
        // alpha-composite cleanly over system passthrough (vs. just being
        // opaque quads) is exactly what the M0 probe measures — do not
        // assume the API below exists until that probe runs on hardware.
    }

    /**
     * Opaque-smoke fallback (spec §13/§17.6): the same `smoke-900` chrome,
     * fully opaque, for when the Spatial SDK's panel alpha compositing over
     * passthrough disappoints (banding, perf cost, driver support) at the M0
     * probe. "The design holds in both states" — same radii, hairline, and
     * specular edge as [RoomGlass], just `alpha = 1.0` instead of ~0.78.
     */
    data object OpaqueSmokeFallback : PanelAlphaMode() {
        val backgroundLayer = MaterialLayer(
            colorHex = "#0b0d10", // --smoke-900
            alpha = 1.0f,
            description = "smoke-900 @ 100% opaque — no passthrough alpha compositing",
        )

        const val NOISE_DESCRIPTION = "fine noise overlay, low amplitude (unchanged from room-glass)"
        const val SPECULAR_EDGE_DESCRIPTION = "specular highlight along the panel's top edge (unchanged)"
        const val HAIRLINE_DESCRIPTION = "1px dichroic hairline border (unchanged)"

        /** Same hairline gradient as [RoomGlass] — the fallback keeps the signature glass detailing. */
        val hairlineGradientHex = listOf("#6ee7f0", "#a78bfa") // --spectra-a, --spectra-b
    }

    companion object {
        /**
         * Default pending the real M0 hardware probe: [OpaqueSmokeFallback].
         *
         * Spec §17.6's phrasing — "room-glass falls back to opaque smoke if
         * panel alpha disappoints" — means room-glass is the state
         * *attempted* first, but opaque smoke is the *safe* state the design
         * is built to hold up in regardless of outcome. This scaffold
         * defaults new panels to the safe state so nothing here assumes an
         * alpha-compositing capability that hasn't been confirmed on real
         * hardware. Flip to [RoomGlass] once the M0 probe on Oskar's Quest 3
         * confirms panel alpha holds up — see .planning/geist/README.md's
         * "Evidence debt" section (H0 is the neighboring hover-coords gate
         * this probe runs alongside, per spec §16).
         */
        val default: PanelAlphaMode = OpaqueSmokeFallback
    }
}
