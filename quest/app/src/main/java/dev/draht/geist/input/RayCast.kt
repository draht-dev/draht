package dev.draht.geist.input

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Pure ray-cast / ray-plane math for geist's addressee resolution
 * (spec §7 quest/ row: "ray→addressee"). Zero Meta Spatial SDK dependency —
 * this is the "ray×plane fallback" explicitly named as in-milestone for M0
 * (spec §16), used when the SDK's own native hit-testing isn't available or
 * isn't precise enough. Real Spatial SDK ray-cast wiring (controller/hand
 * pose → [Ray], and any SDK-native hit-testing) is Phase 32 hardware
 * bring-up; see PassthroughPanel.kt's TODOs.
 */

private const val EPSILON = 1e-6f

/** A point or free vector in 3D world space, shared by rays and panel poses. */
data class Vec3(val x: Float, val y: Float, val z: Float) {
    operator fun plus(other: Vec3): Vec3 = Vec3(x + other.x, y + other.y, z + other.z)

    operator fun minus(other: Vec3): Vec3 = Vec3(x - other.x, y - other.y, z - other.z)

    operator fun times(scalar: Float): Vec3 = Vec3(x * scalar, y * scalar, z * scalar)

    infix fun dot(other: Vec3): Float = x * other.x + y * other.y + z * other.z

    infix fun cross(other: Vec3): Vec3 = Vec3(
        y * other.z - z * other.y,
        z * other.x - x * other.z,
        x * other.y - y * other.x,
    )

    fun length(): Float = sqrt(this dot this)

    /** Returns this vector scaled to unit length. */
    fun normalized(): Vec3 {
        val len = length()
        require(len > EPSILON) { "cannot normalize a zero-length (or near-zero) vector" }
        return this * (1f / len)
    }

    companion object {
        val ZERO = Vec3(0f, 0f, 0f)
        val WORLD_UP = Vec3(0f, 1f, 0f)
    }
}

/** A ray cast from a controller/hand pose: an origin plus a (not necessarily unit) direction. */
data class Ray(val origin: Vec3, val direction: Vec3)

/**
 * An infinite plane described by a point on the plane and its unit normal —
 * the geometric support a rectangular app panel sits on (see [PanelSurface]).
 */
data class Plane(val point: Vec3, val normal: Vec3)

/**
 * A panel's ray-hit surface: the plane it sits on, plus its rectangular
 * extents (half-width / half-height, in meters) so [resolveAddressee] can
 * reject hits that land on the infinite plane but miss the actual panel.
 */
data class PanelSurface(
    val panelId: String,
    val plane: Plane,
    val halfWidth: Float,
    val halfHeight: Float,
)

/** A resolved ray→panel hit: which panel, where on it in world space, and how far away. */
data class PanelHit(val panelId: String, val point: Vec3, val distance: Float)

/**
 * Standard ray-plane intersection. Solves for `t` in
 * `dot((origin + t * direction) - plane.point, plane.normal) = 0`:
 *
 * ```
 * t = dot(plane.point - ray.origin, plane.normal) / dot(ray.direction, plane.normal)
 * ```
 *
 * Returns `null` when the ray is (near-)parallel to the plane — no unique
 * intersection exists, including the degenerate case of a ray lying within
 * the plane — or when the intersection lies behind the ray's origin (`t < 0`).
 */
fun intersectRayPlane(ray: Ray, plane: Plane): Vec3? {
    val denom = ray.direction dot plane.normal
    if (abs(denom) < EPSILON) return null // parallel to the plane

    val t = ((plane.point - ray.origin) dot plane.normal) / denom
    if (t < 0f) return null // intersection is behind the ray's origin

    return ray.origin + ray.direction * t
}

/**
 * Resolves which panel a ray is addressing (spec §7: "ray→addressee"): finds
 * the nearest [PanelSurface] whose plane the ray intersects *and* whose
 * rectangular bounds contain the hit point — the ray×plane fallback named
 * as in-milestone for M0 (spec §16).
 *
 * Bounds are checked against an orthonormal basis derived from each plane's
 * normal (`right = worldUp × normal`, `up = normal × right`), so panels can
 * face any direction, not just toward a fixed world axis. Ties (equal
 * distance) resolve to whichever panel is encountered first in [panels].
 */
fun resolveAddressee(ray: Ray, panels: List<PanelSurface>): PanelHit? {
    var closest: PanelHit? = null

    for (panel in panels) {
        val point = intersectRayPlane(ray, panel.plane) ?: continue

        val normal = panel.plane.normal
        // Guard against the normal being near-parallel to WORLD_UP, which
        // would make `worldUpReference cross normal` degenerate.
        val upReference = if (abs(normal dot Vec3.WORLD_UP) > 0.999f) Vec3(1f, 0f, 0f) else Vec3.WORLD_UP
        val right = (upReference cross normal).normalized()
        val up = (normal cross right).normalized()

        val offset = point - panel.plane.point
        val localX = offset dot right
        val localY = offset dot up
        if (abs(localX) > panel.halfWidth || abs(localY) > panel.halfHeight) continue

        val distance = (point - ray.origin).length()
        val current = closest
        if (current == null || distance < current.distance) {
            closest = PanelHit(panelId = panel.panelId, point = point, distance = distance)
        }
    }

    return closest
}
