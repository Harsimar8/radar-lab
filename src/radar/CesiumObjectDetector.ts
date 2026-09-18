import * as Cesium from "cesium";
import { ObstacleGeometry } from "./CesiumObstacleGeometry";

/**
 * Blocks radar rays on loaded glTF/GLB geometry.
 *
 * Each model's triangles are captured ONCE per radar build into a BVH (see
 * CesiumObstacleGeometry) and intersected directly. Nothing here consults the
 * camera, and nothing consults Cesium's render loop after construction.
 *
 * Cesium's own pickModel is kept only as a fallback for builds where the
 * geometry cannot be read. It is accurate, but it re-walks every triangle of the
 * model on every call, and it takes the model's transform from state that is
 * only refreshed inside a rendered frame - which is what made blocking appear to
 * depend on having moved the camera.
 */
type PickModelFn = (
    model: Cesium.Model,
    ray: Cesium.Ray,
    frameState: unknown,
    verticalExaggeration: number,
    relativeHeight: number,
    ellipsoid: Cesium.Ellipsoid,
    result?: Cesium.Cartesian3
) => Cesium.Cartesian3 | undefined;

const pickModel = (Cesium as unknown as { pickModel?: PickModelFn }).pickModel;

/**
 * Why object blocking did or did not happen on the last radar build.
 *
 * Object blocking fails silently by nature - a ray that is not blocked looks
 * exactly like a ray that was never tested - so every stage that can drop a ray
 * is counted instead of guessed at. The radar lab app puts this on screen.
 */
export interface ObjectDetectorDiagnostics {
    /** How rays are being intersected: our own BVH, or Cesium's per-ray walk. */
    method: "bvh" | "pickModel" | "none";
    pickModelAvailable: boolean;
    primitivesScanned: number;
    modelsFound: number;
    /** Models skipped because they had not finished loading or were hidden. */
    modelsNotReady: number;
    candidates: number;
    /** Total triangles across every blocking model. */
    triangles: number;
    raysTested: number;
    /** Rays that missed every model's bounding sphere, so were never traced. */
    raysRejectedBySphere: number;
    /** Rays that reached the geometry but hit no triangle. */
    raysMissedGeometry: number;
    raysBlocked: number;
    lastError: string | null;
}

interface Candidate {
    model: Cesium.Model;
    boundingSphere: Cesium.BoundingSphere;
    geometry: ObstacleGeometry | null;
}

function emptyDiagnostics(): ObjectDetectorDiagnostics {
    return {
        method: "none",
        pickModelAvailable: typeof pickModel === "function",
        primitivesScanned: 0,
        modelsFound: 0,
        modelsNotReady: 0,
        candidates: 0,
        triangles: 0,
        raysTested: 0,
        raysRejectedBySphere: 0,
        raysMissedGeometry: 0,
        raysBlocked: 0,
        lastError: null
    };
}

export class CesiumObjectDetector {

    private readonly scratchHit = new Cesium.Cartesian3();
    private readonly scratchInterval = new Cesium.Interval();

    private readonly candidates: Candidate[] = [];

    readonly diagnostics: ObjectDetectorDiagnostics = emptyDiagnostics();

    /** Diagnostics from the most recently constructed detector, for debug UI. */
    static latestDiagnostics: ObjectDetectorDiagnostics = emptyDiagnostics();

    /**
     * Must be awaited before constructing a detector.
     *
     * A model's transform is only brought up to date inside model.update(),
     * which runs during a rendered frame. With requestRenderMode on, no frame is
     * drawn unless something asks for one - so a build could capture geometry
     * positioned by the model's PREVIOUS transform, and moving the camera (which
     * forces a frame) was what appeared to decide whether blocking worked.
     * Forcing a frame here makes that deterministic instead of incidental.
     */
    static prepare(viewer: Cesium.Viewer): Promise<void> {

        return new Promise<void>(resolve => {

            const scene = viewer.scene;

            const listener = () => {
                scene.postRender.removeEventListener(listener);
                resolve();
            };

            scene.postRender.addEventListener(listener);
            scene.requestRender();
        });
    }

    constructor(private readonly viewer: Cesium.Viewer) {

        const primitives = viewer.scene.primitives;

        this.diagnostics.primitivesScanned = primitives.length;

        for (let i = 0; i < primitives.length; i++) {

            const primitive = primitives.get(i);

            if (!(primitive instanceof Cesium.Model)) {
                continue;
            }

            const model = primitive as Cesium.Model;

            this.diagnostics.modelsFound++;

            // A model that has not finished loading has no triangles to test yet.
            if (!model.ready || !model.show) {
                this.diagnostics.modelsNotReady++;
                continue;
            }

            // Only matters for the pickModel fallback, which culls back faces
            // whenever this is true - so a ray reaching the concave side of a
            // dish would pass straight through. Our own test is double sided.
            model.backFaceCulling = false;

            let geometry: ObstacleGeometry | null = null;

            try {
                geometry = ObstacleGeometry.fromModel(model);
            } catch (err) {
                this.diagnostics.lastError =
                    err instanceof Error ? err.message : String(err);
            }

            if (geometry) {
                this.diagnostics.triangles += geometry.count;
            }

            this.candidates.push({
                model,
                // Model's own live bounding sphere, already in world space and
                // kept up to date in place, so it follows the model as it moves.
                boundingSphere: model.boundingSphere,
                geometry
            });
        }

        this.diagnostics.candidates = this.candidates.length;

        this.diagnostics.method = this.candidates.length === 0
            ? "none"
            : (this.candidates.every(candidate => candidate.geometry) ? "bvh" : "pickModel");

        CesiumObjectDetector.latestDiagnostics = this.diagnostics;
    }

    /** True when this build of Cesium exposes precise model picking. */
    static get supportsPrecisePicking(): boolean {
        return ObstacleGeometry.isSupported || typeof pickModel === "function";
    }

    /** True when there is nothing in the scene that could block a ray. */
    get isEmpty(): boolean {
        return this.candidates.length === 0;
    }

    /**
     * Distance along the ray to the nearest glTF/GLB surface, or Infinity if the
     * ray reaches maxDistance without touching one.
     */
    getFirstObjectHit(ray: Cesium.Ray, maxDistance: number): number {

        if (this.isEmpty) {
            return Number.POSITIVE_INFINITY;
        }

        this.diagnostics.raysTested++;

        let nearestDistance = Number.POSITIVE_INFINITY;
        let reachedGeometry = false;

        for (const candidate of this.candidates) {

            // Cheap reject before the geometry pass: most rays of a 20km zone go
            // nowhere near a building-sized obstacle.
            const interval = Cesium.IntersectionTests.raySphere(
                ray,
                candidate.boundingSphere,
                this.scratchInterval
            );

            if (!interval || interval.start > maxDistance || interval.stop < 0) {
                continue;
            }

            reachedGeometry = true;

            const distance = candidate.geometry
                ? candidate.geometry.intersect(ray, maxDistance)
                : this.pickModelDistance(candidate.model, ray, maxDistance);

            if (distance < nearestDistance) {
                nearestDistance = distance;
            }
        }

        if (!reachedGeometry) {
            this.diagnostics.raysRejectedBySphere++;
        } else if (nearestDistance === Number.POSITIVE_INFINITY) {
            this.diagnostics.raysMissedGeometry++;
        } else {
            this.diagnostics.raysBlocked++;
        }

        return nearestDistance;
    }

    /** Fallback path, used only when a model's triangles could not be read. */
    private pickModelDistance(
        model: Cesium.Model,
        ray: Cesium.Ray,
        maxDistance: number
    ): number {

        if (!pickModel) {
            return Number.POSITIVE_INFINITY;
        }

        const scene = this.viewer.scene;

        try {
            const hit = pickModel(
                model,
                ray,
                (scene as unknown as { frameState: unknown }).frameState,
                1.0,
                0.0,
                scene.ellipsoid ?? Cesium.Ellipsoid.WGS84,
                this.scratchHit
            );

            if (!hit) {
                return Number.POSITIVE_INFINITY;
            }

            const distance = Cesium.Cartesian3.distance(ray.origin, hit);

            return distance >= 0 && distance <= maxDistance
                ? distance
                : Number.POSITIVE_INFINITY;

        } catch (err) {
            this.diagnostics.lastError =
                err instanceof Error ? err.message : String(err);
            return Number.POSITIVE_INFINITY;
        }
    }
}
