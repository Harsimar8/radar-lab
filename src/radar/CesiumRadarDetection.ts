import * as Cesium from "cesium";

/**
 * Target detection for a radar.
 *
 * This is deliberately NOT done by looking for objects in the sampled ray grid.
 * That grid exists to draw the beam, and its resolution is bounded by what can
 * be meshed and terrain-sampled in reasonable time - a few hundred azimuths at
 * best. An object smaller than the gap between neighbouring rays falls straight
 * between them and is never seen, so a ray-grid search can only detect things
 * roughly as large as its own sampling step.
 *
 * Instead each target is solved for directly: its bearing, elevation and slant
 * range from the antenna are computed exactly, tested against the beam's limits,
 * and then checked for terrain line-of-sight along its own azimuth. The cost is
 * one terrain profile per target, and the smallest detectable object is set by
 * the target's own size rather than by the beam's drawing resolution - so a
 * bullet-sized object in the beam is detected exactly as reliably as a hangar.
 */

/** Something a radar can see. Position and radius are world-space metres. */
export interface DetectionTarget {
    id: string;
    name: string;
    /** Centre of the object, in ECEF. */
    position: Cesium.Cartesian3;
    /** Bounding radius, so a large object counts as seen if any part is lit. */
    radius: number;
}

export interface Detection {
    targetId: string;
    targetName: string;
    /** The zone whose beam holds it - the shortest-range one that does. */
    zoneName: string;
    slantRangeM: number;
    bearingDeg: number;
    elevationDeg: number;
    /**
     * True when the target is inside the beam's limits but terrain stands
     * between it and the antenna, so the beam is cut short before reaching it.
     */
    terrainShadowed: boolean;
}

/** Where a target sits relative to the antenna. */
export interface TargetGeometry {
    slantRangeM: number;
    bearingDeg: number;
    elevationDeg: number;
    /**
     * Half-angle the target subtends at the antenna. A target is in the beam if
     * any part of it is, so every limit test is widened by this.
     */
    angularRadiusDeg: number;
}

const scratchInverse = new Cesium.Matrix4();
const scratchLocal = new Cesium.Cartesian3();

function normalizeDegrees(value: number): number {
    return ((value % 360) + 360) % 360;
}

/**
 * Resolves a target into bearing / elevation / slant range in the antenna's
 * local frame. enuMatrix is the east-north-up frame at the antenna, so its
 * inverse takes a world point into metres east, north and up of it.
 */
export function targetGeometry(
    radarPosition: Cesium.Cartesian3,
    enuMatrix: Cesium.Matrix4,
    target: DetectionTarget
): TargetGeometry {

    Cesium.Matrix4.inverseTransformation(enuMatrix, scratchInverse);
    Cesium.Matrix4.multiplyByPoint(scratchInverse, target.position, scratchLocal);

    const east = scratchLocal.x;
    const north = scratchLocal.y;
    const up = scratchLocal.z;

    const horizontal = Math.hypot(east, north);
    const slantRangeM = Math.hypot(horizontal, up);

    const bearingDeg = normalizeDegrees(
        Cesium.Math.toDegrees(Math.atan2(east, north))
    );

    const elevationDeg = Cesium.Math.toDegrees(Math.atan2(up, horizontal));

    // Guard the degenerate case of the antenna standing inside the target.
    const angularRadiusDeg = slantRangeM > target.radius
        ? Cesium.Math.toDegrees(Math.asin(target.radius / slantRangeM))
        : 180;

    return { slantRangeM, bearingDeg, elevationDeg, angularRadiusDeg };
}

/**
 * True when a bearing falls inside a sector, allowing for the 359 -> 0 seam.
 * marginDeg widens both edges, so a target only partly inside still counts.
 */
export function isWithinSector(
    bearingDeg: number,
    sectorStartDeg: number,
    sweepDeg: number,
    marginDeg: number
): boolean {

    if (sweepDeg >= 360) {
        return true;
    }

    // Distance travelled clockwise from the sector's leading edge. Doing the
    // comparison in this space means the seam needs no special case.
    const offset = normalizeDegrees(bearingDeg - sectorStartDeg);

    return offset <= sweepDeg + marginDeg || offset >= 360 - marginDeg;
}

/** Builds detection targets from the glTF/GLB models currently in the scene. */
export function collectModelTargets(
    viewer: Cesium.Viewer,
    nameFor: (model: Cesium.Model, index: number) => { id: string; name: string }
): DetectionTarget[] {

    const targets: DetectionTarget[] = [];
    const primitives = viewer.scene.primitives;

    for (let i = 0; i < primitives.length; i++) {

        const primitive = primitives.get(i);

        if (!(primitive instanceof Cesium.Model)) {
            continue;
        }

        const model = primitive as Cesium.Model;

        if (!model.ready || !model.show) {
            continue;
        }

        const sphere = model.boundingSphere;
        const { id, name } = nameFor(model, i);

        targets.push({
            id,
            name,
            position: Cesium.Cartesian3.clone(sphere.center, new Cesium.Cartesian3()),
            radius: sphere.radius
        });
    }

    return targets;
}
