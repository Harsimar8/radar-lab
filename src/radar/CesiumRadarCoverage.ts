import * as Cesium from "cesium";
import { CesiumObjectDetector } from "./CesiumObjectDetector";
import {
    type Detection,
    type DetectionTarget,
    isWithinSector,
    targetGeometry
} from "./CesiumRadarDetection";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;             // source Entity.id - tagged onto every pickable piece so a
    // click anywhere on the radar resolves back to it
    longitude: number;
    latitude: number;
    altitude?: number;
    mastHeight?: number;          // antenna mast height above terrain (m)
    headingDeg?: number;          // direction the whole radar faces, 0 = north, clockwise.
    // The sector is centred on it, so changing heading swings
    // every zone together without changing their widths.
    // Ignored for a full circle, which has no facing.
    sectorSweepDeg?: number;      // sector width about the heading, 360 = full circle
    drawRays?: boolean;           // overlay the raw sampling rays. While on, the translucent
    // fill and ground footprint are hidden so the rays are
    // readable against the terrain.
    azimuthStepDeg?: number;      // BASE wall vertex density, before adaptive refinement
    refinementPasses?: number;    // how many times a terrain shadow edge may be re-traced at
    // half the angular step (default 2), so the wall's edge
    // lands on the real ridge silhouette instead of being
    // guessed between two rays that are degrees apart
    rangeSampleSteps?: number;    // distance samples per ray. Leave unset to derive it from
    // the zone's range at a fixed ground spacing, which keeps
    // every zone equally accurate; set it only to pin a count.
    elevationRingsPerZone?: number; // how many elevation rings sampled per zone (default 6, min 2)
    useObjectPicking?: boolean;   // also test rays against loaded glTF/GLB models (default false)
    beamOpacity?: number;         // alpha of one beam surface (default 0.12). Kept low because
    // a closed volume puts several surfaces between the eye and
    // the ground and three nested zones stack them, so a value
    // that looks right for one beam turns three into a wall of
    // colour.
    markBlockedRays?: boolean;    // dot every ray that was stopped early, coloured by what
    // stopped it. Works with the solid beam, so where the
    // beam is cut can be read without the full ray overlay.
    blockOnTargetBounds?: boolean; // also stop rays on each target's BOUNDING SPHERE,
    // not just on its triangles (default false). Coarse on
    // purpose - see the note on targetBoundsBlockDistance.
    emptyObjectShadow?: boolean;  // leave the space an object blocks completely empty
    // (default false). Off, the faces of the bite are shaded
    // and the rays that hit the object are dotted, so the cut
    // is visible from outside. On, nothing at all is drawn
    // there: the beam simply stops, and what marks the object
    // is the object - see the note by the shadow primitive.
    showMarker?: boolean;         // draw the antenna dot (default true). Turn it off when the
    // caller keeps its own persistent marker: this one is
    // disposed and recreated on every rebuild, so it blinks out
    // for the length of the build and vanishes entirely if a
    // build fails.
    beamStyle?: "solid" | "lattice"; // "solid" (default) draws each zone as one clean
    // beam - fill plus a silhouette edge. "lattice" adds the
    // internal ring/rib grid, which reads as a bundle of rays.
    targets?: DetectionTarget[];  // objects to test against the beams. Detection is
    // analytic, not a search of the ray grid, so an object
    // far smaller than the ray spacing is still found.
    onDetections?: (detections: Detection[]) => void;
    zoneOverrides?: Record<string, RadarZoneOverride>;
}

export interface RadarZoneOverride {
    visible?: boolean;
    range?: number;
    minElevationDeg?: number;
    maxElevationDeg?: number;
    /**
     * Whether this zone is selected for the inspection overlays - stop marks,
     * individual rays, and the beam sampling grid. Defaults to true.
     *
     * Separate from `visible` on purpose: three zones' worth of rays on screen
     * at once is unreadable, and turning a zone off entirely to quieten the
     * overlay would also remove the beam you were trying to look at.
     */
    showOverlay?: boolean;
}

export interface RadarZoneConfig {
    name: string;
    cssColor: string;
    color: Cesium.Color;
    defaultRange: number;
    defaultMinElevationDeg: number;
    defaultMaxElevationDeg: number;
}

interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    showOverlay: boolean;
}

/** Ground heights down one azimuth, shared by every elevation ring and zone. */
interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
}

/**
 * One azimuth's worth of the coverage surface: where every elevation ring's ray
 * stopped. `offset` is the angle from the sector's leading edge (0..sweep),
 * which is monotonic and wrap-safe, so refinement can insert midpoints without
 * worrying about the 359 -> 0 seam.
 */
/** What ended a ray. Ordered so the drawing code can switch on it. */
export const enum StopCause {
    /** Nothing stopped it - it simply ran out of zone range. */
    Range = 0,
    Terrain = 1,
    Object = 2
}

interface ZoneColumn {
    offset: number;
    azimuthDeg: number;
    points: Cesium.Cartesian3[];
    distances: number[];
    /** Per ring: true when an object, not terrain, is what stopped the ray. */
    objectHits: boolean[];
    /** Per ring: what ended the ray, for the debug overlay and the stats. */
    causes: StopCause[];
}

/** One sampled ray: where it stopped, how far along, and on what. */
interface TracedRay {
    point: Cesium.Cartesian3;
    distance: number;
    hitObject: boolean;
    cause: StopCause;
}

/** Everything create3DRadarZones() built for one radar, so callers can clean up later. */
export interface RadarCoverageHandle {
    dispose(): void;
}

// =============================================================================
// Tuning constants
// =============================================================================

// Ray-march spacing along a ray, in metres. Sampling by ground distance rather
// than by a fixed step count keeps every zone equally accurate: a fixed count
// would sample a 20km zone four times coarser than a 5km one, which is what let
// rays step straight over narrow ridges and carry on through the mountain.
const TERRAIN_SAMPLE_SPACING_M = 30;

// Ceiling on samples per azimuth. Spacing alone is unbounded - a 200km zone at
// 30m would be 6600 samples on every one of a hundred azimuths - so beyond this
// the spacing is allowed to coarsen instead of the sample count growing.
const MAX_PROFILE_SAMPLES = 700;

// Mean earth radius, used to account for the earth curving away beneath a
// straight ray instead of treating the local tangent plane as flat.
const EARTH_RADIUS_M = 6371000;

// Two neighbouring columns sit on opposite sides of a terrain shadow edge when
// their ranges differ by more than this, and are then NOT joined into a wall.
// It is deliberately a floor in metres AND a fraction of the zone range: a pure
// ratio is too strict close in - a 200m -> 400m step is a ratio of 2 and left a
// hole - and far too loose far out, where a 14km -> 20km step is a ratio of only
// 1.4 and was drawn as a 6km blade lying across the ridge.
const SHADOW_EDGE_MIN_STEP_M = 150;
const SHADOW_EDGE_RANGE_FRACTION = 0.12;

// A shadow edge is re-traced at finer and finer angles until it is this narrow,
// across the beam and up it. These are small because the thing being resolved is
// often not a ridge but an object: a 60m building at 5km subtends about 0.7
// degrees, and a step coarser than that closes the beam back over it.
const MIN_REFINED_AZIMUTH_STEP_DEG = 0.2;
const MIN_REFINED_ELEVATION_STEP_DEG = 0.2;

// A closing curtain spans from where the near ray stopped out to where its
// neighbour reached, and it is only a WALL while that span stays short.
//
// Two limits, and both matter. The angular one keeps it from spanning degrees of
// azimuth. The range one keeps it from spanning kilometres of ground: once
// refinement has pinned an edge to a fifth of a degree the angular test passes
// for every pair, including one where a ray stopped at 500m against a ridge and
// its neighbour flew 16km down the valley. Closing across THAT does not make a
// wall - it makes a sheet lying over the whole shadow, which is why the beam
// kept appearing to carry on past the thing that had cut it.
//
// Past either limit the surface breaks, and the column is capped instead.
const MAX_CURTAIN_GAP_DEG = 0.75;
const MIN_CURTAIN_JUMP_M = 300;
const MAX_CURTAIN_JUMP_RANGE_FRACTION = 0.08;

// Hard ceilings per zone, so pathological terrain (a whole horizon of broken
// ridges) cannot turn one rebuild into a hundred thousand terrain samples.
// Refinement only ever spends these at edges, so an open plain uses almost none.
const MAX_COLUMNS_PER_ZONE = 600;
const MAX_RINGS_PER_ZONE = 26;

// Where a target stands, the beam is sampled at its silhouette directly rather
// than left to the refinement heuristic. These are the fractions of the target's
// angular radius that get a sample, either side of its centre: edge, mid, near
// centre, centre. Refinement can still add more, but this alone guarantees rays
// are cast AT the object instead of hoping two neighbouring rays disagree enough
// to be split towards it.
const TARGET_SEED_FRACTIONS = [-1.05, -0.7, -0.35, 0, 0.35, 0.7, 1.05];

// Floor on a seeded target's angular radius. A distant, small object subtends
// almost nothing, and seeds spaced by a millidegree would just pile up on one
// another without resolving anything.
const MIN_TARGET_SEED_RADIUS_DEG = 0.15;

// Two sample angles closer together than this are treated as the same angle.
const ANGLE_MERGE_EPSILON_DEG = 0.02;

// The mesh is sampled far more finely than is readable as a lattice, so the
// wireframe ribs and the debug rays are decimated down to roughly these counts.
// Drawing one rib per column would bury the wall under its own wireframe.
const WIREFRAME_TARGET_RIBS = 36;

// The debug ray overlay draws EVERY sampled ray, because its whole purpose is to
// show how densely the beam is actually sampled - a decimated overlay showed a
// thin fan and gave the opposite impression. This is only a ceiling to stop a
// heavily refined zone from queueing tens of thousands of polylines.
const MAX_DEBUG_RAYS_PER_ZONE = 6000;

// What stopped a ray, in colour. Deliberately NOT the zone colour: the whole
// point of the overlay is to tell blocked rays apart from ones that simply ran
// out of range, and a zone-coloured fan cannot say which is which.
const STOP_COLOR_TERRAIN = Cesium.Color.fromCssColorString("#f59e0b");
const STOP_COLOR_OBJECT = Cesium.Color.fromCssColorString("#ef4444");

// =============================================================================
// Geometry helpers (the profile cache needs them too, so module level)
// =============================================================================

const scratchTargetSphere = new Cesium.BoundingSphere();
const scratchTargetInterval = new Cesium.Interval();

function normalizeDegrees(value: number): number {
    return ((value % 360) + 360) % 360;
}

function makeRay(
    radarPosition: Cesium.Cartesian3,
    enuMatrix: Cesium.Matrix4,
    azimuthDeg: number,
    elevationDeg: number
): Cesium.Ray {

    const azimuth = Cesium.Math.toRadians(azimuthDeg);
    const elevation = Cesium.Math.toRadians(elevationDeg);

    const localDirection = new Cesium.Cartesian3(
        Math.sin(azimuth) * Math.cos(elevation),
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation)
    );

    const worldDirection = Cesium.Matrix4.multiplyByPointAsVector(
        enuMatrix,
        localDirection,
        new Cesium.Cartesian3()
    );

    Cesium.Cartesian3.normalize(worldDirection, worldDirection);

    return new Cesium.Ray(radarPosition, worldDirection);
}

// =============================================================================
// Terrain profile cache
// =============================================================================

/**
 * Ground-height profiles keyed by azimuth, sampled on demand and shared by every
 * elevation ring of every zone.
 *
 * It is a cache rather than a one-shot batch for two reasons. Adaptive
 * refinement asks for extra azimuths part-way through a build, and those must
 * not force a re-sample of the azimuths already in hand. And the profiles depend
 * only on where the radar stands and how far it looks - not on its heading, its
 * mast height, or any zone's elevation limits - so the whole set survives a
 * rebuild, which is what makes dragging the heading slider cheap.
 */
class TerrainProfileCache {

    private readonly profiles = new Map<string, TerrainProfile>();
    private readonly horizontalDistances: number[];
    private readonly geodesic = new Cesium.EllipsoidGeodesic();
    private readonly start: Cesium.Cartographic;

    constructor(
        private readonly terrainProvider: Cesium.TerrainProvider,
        private readonly radarPosition: Cesium.Cartesian3,
        private readonly enuMatrix: Cesium.Matrix4,
        private readonly maxRange: number,
        spacing: number
    ) {
        const steps = Math.min(
            MAX_PROFILE_SAMPLES,
            Math.max(2, Math.ceil(maxRange / spacing))
        );

        const effectiveSpacing = maxRange / steps;

        this.horizontalDistances = [];
        for (let i = 0; i <= steps; i++) {
            this.horizontalDistances.push(Math.min(i * effectiveSpacing, maxRange));
        }

        const radarCartographic = Cesium.Cartographic.fromCartesian(radarPosition);
        this.start = Cesium.Cartographic.fromRadians(
            radarCartographic.longitude,
            radarCartographic.latitude,
            0
        );
    }

    /** A cached set is only reusable while it describes the same terrain source. */
    matches(terrainProvider: Cesium.TerrainProvider): boolean {
        return this.terrainProvider === terrainProvider;
    }

    private static key(azimuthDeg: number): string {
        return normalizeDegrees(azimuthDeg).toFixed(4);
    }

    /** How many azimuths have had their ground profile sampled. */
    get size(): number {
        return this.profiles.size;
    }

    has(azimuthDeg: number): boolean {
        return this.profiles.has(TerrainProfileCache.key(azimuthDeg));
    }

    get(azimuthDeg: number): TerrainProfile {
        const profile = this.profiles.get(TerrainProfileCache.key(azimuthDeg));

        if (!profile) {
            throw new Error(`No terrain profile sampled for azimuth ${azimuthDeg}`);
        }

        return profile;
    }

    /** Samples terrain for any of these azimuths not already held. */
    async ensure(azimuthsDeg: number[]): Promise<void> {

        const missing: number[] = [];
        const queued = new Set<string>();

        for (const azimuthDeg of azimuthsDeg) {
            const key = TerrainProfileCache.key(azimuthDeg);

            if (this.profiles.has(key) || queued.has(key)) {
                continue;
            }

            queued.add(key);
            missing.push(azimuthDeg);
        }

        if (missing.length === 0) {
            return;
        }

        const flatCartographics: Cesium.Cartographic[] = [];
        const scratchPoint = new Cesium.Cartesian3();
        const sampleCount = this.horizontalDistances.length;
        const lastIndex = sampleCount - 1;

        for (const azimuthDeg of missing) {

            // The ground track is a geodesic, so it is walked by interpolating
            // one - ONE inverse-cartesian per azimuth instead of one per sample.
            // Converting every sample point back from ECEF (as this used to) is
            // an iterative solve, and at ~700 samples x ~100 azimuths it was the
            // single most expensive thing in a rebuild.
            const groundRay = makeRay(this.radarPosition, this.enuMatrix, azimuthDeg, 0);
            const endPoint = Cesium.Ray.getPoint(groundRay, this.maxRange, scratchPoint);

            this.geodesic.setEndPoints(
                this.start,
                Cesium.Cartographic.fromCartesian(endPoint)
            );

            for (let i = 0; i < sampleCount; i++) {
                flatCartographics.push(
                    this.geodesic.interpolateUsingFraction(i / lastIndex)
                );
            }
        }

        const sampled = await Cesium.sampleTerrainMostDetailed(
            this.terrainProvider,
            flatCartographics
        );

        missing.forEach((azimuthDeg, index) => {

            const groundHeights: number[] = [];
            const base = index * sampleCount;

            for (let i = 0; i < sampleCount; i++) {
                groundHeights.push(sampled[base + i].height ?? 0);
            }

            this.profiles.set(TerrainProfileCache.key(azimuthDeg), {
                azimuthDeg,
                horizontalDistances: this.horizontalDistances,
                groundHeights
            });
        });
    }
}

// Profiles survive between rebuilds, keyed by everything they actually depend
// on. Heading and mast height are deliberately absent from the key: neither
// changes the ground under an azimuth, so swinging the radar re-uses the whole
// set and costs nothing but re-tracing and re-meshing.
const profileCacheStore = new Map<string, TerrainProfileCache>();
const MAX_CACHED_PROFILE_SETS = 6;

function acquireProfileCache(
    terrainProvider: Cesium.TerrainProvider,
    radarPosition: Cesium.Cartesian3,
    enuMatrix: Cesium.Matrix4,
    longitude: number,
    latitude: number,
    maxRange: number,
    spacing: number
): TerrainProfileCache {

    const key = [
        longitude.toFixed(6),
        latitude.toFixed(6),
        maxRange.toFixed(1),
        spacing.toFixed(3)
    ].join("|");

    const existing = profileCacheStore.get(key);

    if (existing && existing.matches(terrainProvider)) {
        // Re-insert so the map's insertion order doubles as an LRU list.
        profileCacheStore.delete(key);
        profileCacheStore.set(key, existing);
        return existing;
    }

    const cache = new TerrainProfileCache(
        terrainProvider,
        radarPosition,
        enuMatrix,
        maxRange,
        spacing
    );

    profileCacheStore.set(key, cache);

    while (profileCacheStore.size > MAX_CACHED_PROFILE_SETS) {
        const oldest = profileCacheStore.keys().next().value;
        if (oldest === undefined) break;
        profileCacheStore.delete(oldest);
    }

    return cache;
}

// =============================================================================
// CesiumRadarCoverage
// =============================================================================

export class CesiumRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [
        {
            name: "Zone 1 (Low)",
            cssColor: "#22c55e",
            color: Cesium.Color.fromCssColorString("#22c55e"),
            defaultRange: 5000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 10
        },
        {
            name: "Zone 2 (Mid)",
            cssColor: "#f59e0b",
            color: Cesium.Color.fromCssColorString("#f59e0b"),
            defaultRange: 16000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 20
        },
        {
            name: "Zone 3 (High / Wide)",
            cssColor: "#3b82f6",
            color: Cesium.Color.fromCssColorString("#3b82f6"),
            defaultRange: 20000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 30
        }
    ];

    /** Drops every cached terrain profile, e.g. when the terrain source changes. */
    static clearTerrainCache(): void {
        profileCacheStore.clear();
    }

    /**
     * How densely the last build actually sampled, for debug UI.
     *
     * Density is adaptive, so the only honest way to know how many rays a beam
     * is made of is to count them - the settings are ceilings and starting
     * points, not the answer.
     */
    static lastBuildStats = {
        zones: 0,
        columns: 0,
        rings: 0,
        rays: 0,
        profileAzimuths: 0,
        /** Rays that reached full range because nothing stopped them. */
        stoppedByRange: 0,
        stoppedByTerrain: 0,
        stoppedByObject: 0
    };

    // -------------------------------------------------------------------
    // Public entry point
    // -------------------------------------------------------------------

    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions
    ): Promise<RadarCoverageHandle[]> {

        const {
            entityId,
            longitude,
            latitude,
            mastHeight = 0,
            headingDeg = 0,
            sectorSweepDeg = 360,
            drawRays = false,
            azimuthStepDeg = 2.5,
            refinementPasses = 5,
            rangeSampleSteps,
            elevationRingsPerZone = 8,
            useObjectPicking = false,
            showMarker = true,
            beamOpacity = 0.12,
            markBlockedRays = false,
            blockOnTargetBounds = false,
            emptyObjectShadow = false,
            beamStyle = "solid",
            targets,
            onDetections,
            zoneOverrides = {}
        } = options;

        const handles: RadarCoverageHandle[] = [];

        // ---------------------------------------------------------------
        // 1. Radar base position (terrain sampling - authoritative)
        // ---------------------------------------------------------------

        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider, [cartographic]);
        const terrainHeight = sampled.height ?? 0;

        const radarPosition = Cesium.Cartesian3.fromDegrees(
            longitude,
            latitude,
            terrainHeight + mastHeight
        );

        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);

        // ---------------------------------------------------------------
        // 2. Radar marker
        // ---------------------------------------------------------------

        if (showMarker) {

            const marker = viewer.entities.add({
                position: radarPosition,
                point: {
                    pixelSize: 18,
                    color: Cesium.Color.BLACK,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 3,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });

            // Tag every pickable piece with the source entity id so a click/drag
            // anywhere on the radar (marker, wall, footprint) resolves back to
            // it - see CesiumSelection.selectEntity's radarParentId lookup.
            (marker as any).radarParentId = entityId;
            handles.push({ dispose: () => viewer.entities.remove(marker) });
        }

        // ---------------------------------------------------------------
        // 3. Sector geometry
        // ---------------------------------------------------------------

        const sweepDeg = Cesium.Math.clamp(sectorSweepDeg, 1, 360);
        const isFullCircle = sweepDeg >= 360;

        // Heading is where the radar points and the sector straddles it, so a
        // sector rotates about the heading instead of growing off one edge.
        // A full circle has no facing at all, so it pins to north - which also
        // means swinging the heading of an all-round radar rebuilds nothing.
        const sectorStartDeg = isFullCircle
            ? 0
            : normalizeDegrees(headingDeg - sweepDeg / 2);

        // ---------------------------------------------------------------
        // 4. Resolve visible zones
        // ---------------------------------------------------------------

        const visibleZones: ResolvedZone[] = [];

        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {

            const override = zoneOverrides[zoneConfig.name] ?? {};

            if (!(override.visible ?? true)) {
                continue;
            }

            visibleZones.push({
                name: zoneConfig.name,
                color: zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                minElevationDeg: override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg,
                maxElevationDeg: override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg,
                showOverlay: override.showOverlay ?? true
            });
        }

        if (visibleZones.length === 0) {
            return handles;
        }

        const maxZoneRange = Math.max(...visibleZones.map(zone => zone.range));

        const profileSpacing = rangeSampleSteps
            ? maxZoneRange / Math.max(2, rangeSampleSteps)
            : TERRAIN_SAMPLE_SPACING_M;

        const profiles = acquireProfileCache(
            terrainProvider,
            radarPosition,
            enuMatrix,
            longitude,
            latitude,
            maxZoneRange,
            profileSpacing
        );

        const radarHeight = terrainHeight + mastHeight;

        CesiumRadarCoverage.lastBuildStats = {
            zones: 0,
            columns: 0,
            rings: 0,
            rays: 0,
            profileAzimuths: 0,
            stoppedByRange: 0,
            stoppedByTerrain: 0,
            stoppedByObject: 0
        };

        // A model's transform is only refreshed inside a rendered frame, so the
        // detector waits for one before capturing geometry. Without this a build
        // could read the model's previous transform, and moving the camera -
        // which forces a frame - was what appeared to decide whether obstacles
        // blocked anything.
        if (useObjectPicking) {
            await CesiumObjectDetector.prepare(viewer);
        }

        const objectDetector = useObjectPicking
            ? new CesiumObjectDetector(viewer)
            : null;

        // ---------------------------------------------------------------
        // 5. Build each zone
        // ---------------------------------------------------------------

        for (const zone of visibleZones) {

            const baseElevationRingsDeg = CesiumRadarCoverage.buildElevationRings(
                zone.minElevationDeg,
                zone.maxElevationDeg,
                elevationRingsPerZone
            );

            // One set of real ray-hit columns, refined at terrain shadow edges.
            // Everything below - the fill volume, the wireframe, the ground
            // footprint, and the optional debug ray overlay - is built from
            // these SAME columns, so they can never disagree with each other.
            // Refinement can add elevation rings as well as azimuths, so the
            // ring list comes back out rather than going only in.
            const { columns, elevationRingsDeg } = await CesiumRadarCoverage.buildZoneColumns(
                radarPosition,
                radarHeight,
                enuMatrix,
                zone,
                sectorStartDeg,
                sweepDeg,
                isFullCircle,
                azimuthStepDeg,
                refinementPasses,
                baseElevationRingsDeg,
                profiles,
                objectDetector,
                targets ?? [],
                blockOnTargetBounds
            );

            const stats = CesiumRadarCoverage.lastBuildStats;
            stats.zones++;
            stats.columns += columns.length;
            stats.rings = Math.max(stats.rings, elevationRingsDeg.length);
            stats.rays += columns.length * elevationRingsDeg.length;
            stats.profileAzimuths = profiles.size;

            for (const column of columns) {
                for (const cause of column.causes) {
                    if (cause === StopCause.Object) stats.stoppedByObject++;
                    else if (cause === StopCause.Terrain) stats.stoppedByTerrain++;
                    else stats.stoppedByRange++;
                }
            }

            // Which neighbouring columns are close enough in range to be joined
            // into one continuous wall. Everything drawn below agrees on this,
            // so a break in the wall is a break in the wireframe too.
            const { surface: surfaceJoins, shadowEdge } =
                CesiumRadarCoverage.computeJoins(zone, columns, isFullCircle);

            // Rays on = an x-ray view: the translucent fill and the ground
            // footprint are hidden so the individual rays read against the
            // terrain. Rays off = the solid shaded coverage volume.
            const showShading = !drawRays;

            const meshPrimitive = showShading
                ? CesiumRadarCoverage.buildMeshPrimitive(
                    zone,
                    columns,
                    surfaceJoins,
                    shadowEdge,
                    elevationRingsDeg,
                    isFullCircle,
                    radarPosition,
                    entityId,
                    beamOpacity
                )
                : null;

            if (meshPrimitive) {
                viewer.scene.primitives.add(meshPrimitive);
            }

            // Nothing is drawn in the space an object blocks.
            //
            // The shaded bite faces below exist because a dent in a surface
            // drawn at 0.12 alpha is invisible from outside, and without them
            // the beam looked as though it had sailed through the obstacle.
            // But they are drawn in red at 0.45, which fills the very volume
            // the object is supposed to have emptied - so the answer to "is
            // this space covered?" was painted over the space itself, and the
            // harder they were drawn the less the hole read as a hole.
            //
            // With this on, the cut is shown by its own edges: the beam runs
            // normally up to the object, stops, and leaves a clean void behind
            // it exactly as wide as the thing that cast it. What marks the
            // object is a silhouette on the object.
            const objectShadowPrimitive = (showShading && !emptyObjectShadow)
                ? CesiumRadarCoverage.buildObjectShadowPrimitive(
                    columns,
                    elevationRingsDeg.length,
                    isFullCircle,
                    entityId
                )
                : null;

            if (objectShadowPrimitive) {
                viewer.scene.primitives.add(objectShadowPrimitive);
            }

            const wireframePrimitive = CesiumRadarCoverage.buildWireframePrimitive(
                zone,
                columns,
                shadowEdge,
                elevationRingsDeg.length,
                isFullCircle,
                entityId,
                // The sampling grid is an inspection overlay like the rays, so
                // it follows the same selection - otherwise turning it on to
                // study one beam draws a lattice through all three.
                zone.showOverlay ? beamStyle : "solid"
            );
            if (wireframePrimitive) {
                viewer.scene.primitives.add(wireframePrimitive);
            }

            const footprintEntities = showShading
                ? CesiumRadarCoverage.buildGroundFootprint(
                    viewer,
                    zone,
                    columns,
                    isFullCircle,
                    radarPosition,
                    entityId
                )
                : [];

            const rayOverlay = ((drawRays || markBlockedRays) && zone.showOverlay)
                ? CesiumRadarCoverage.buildRayOverlay(
                    viewer,
                    radarPosition,
                    zone,
                    columns,
                    elevationRingsDeg.length,
                    drawRays,
                    // A dot sits at the point a ray died, which is ON the
                    // object's near face - inside the space that is meant to
                    // read as empty. Terrain dots are unaffected: terrain is
                    // not what this is emptying.
                    !emptyObjectShadow
                )
                : null;

            handles.push({
                dispose: () => {
                    if (meshPrimitive) viewer.scene.primitives.remove(meshPrimitive);
                    if (objectShadowPrimitive) viewer.scene.primitives.remove(objectShadowPrimitive);
                    if (wireframePrimitive) viewer.scene.primitives.remove(wireframePrimitive);
                    for (const entity of footprintEntities) viewer.entities.remove(entity);
                    if (rayOverlay) rayOverlay.dispose();
                }
            });

            viewer.scene.requestRender();
        }

        if (onDetections) {
            onDetections(
                await CesiumRadarCoverage.detectTargets(
                    targets ?? [],
                    visibleZones,
                    radarPosition,
                    radarHeight,
                    enuMatrix,
                    sectorStartDeg,
                    sweepDeg,
                    profiles
                )
            );
        }

        return handles;
    }

    // -------------------------------------------------------------------
    // Target detection
    //
    // Solved per target rather than by looking for objects in the ray grid.
    // The grid's resolution is whatever can be meshed and terrain-sampled in
    // reasonable time, so anything smaller than the gap between neighbouring
    // rays falls between them and is never seen. Here the exact bearing,
    // elevation and range are computed, tested against the beam's limits, and
    // then checked for line of sight along the target's own azimuth - which
    // costs one terrain profile per target and finds an object of any size.
    // -------------------------------------------------------------------

    private static async detectTargets(
        targets: DetectionTarget[],
        zones: ResolvedZone[],
        radarPosition: Cesium.Cartesian3,
        radarHeight: number,
        enuMatrix: Cesium.Matrix4,
        sectorStartDeg: number,
        sweepDeg: number,
        profiles: TerrainProfileCache
    ): Promise<Detection[]> {

        if (targets.length === 0 || zones.length === 0) {
            return [];
        }

        const geometries = targets.map(
            target => targetGeometry(radarPosition, enuMatrix, target)
        );

        // Line of sight needs the ground profile along each target's own
        // bearing, which is almost never one of the drawing azimuths.
        const bearingsNeeded: number[] = [];

        for (let t = 0; t < targets.length; t++) {

            const geometry = geometries[t];

            const inAnyZone = zones.some(zone =>
                geometry.slantRangeM - targets[t].radius <= zone.range
            );

            if (!inAnyZone) {
                continue;
            }

            if (!isWithinSector(
                geometry.bearingDeg,
                sectorStartDeg,
                sweepDeg,
                geometry.angularRadiusDeg
            )) {
                continue;
            }

            bearingsNeeded.push(geometry.bearingDeg);
        }

        await profiles.ensure(bearingsNeeded);

        const detections: Detection[] = [];

        for (let t = 0; t < targets.length; t++) {

            const target = targets[t];
            const geometry = geometries[t];

            if (!isWithinSector(
                geometry.bearingDeg,
                sectorStartDeg,
                sweepDeg,
                geometry.angularRadiusDeg
            )) {
                continue;
            }

            // Zones are nested, so the first one that holds the target is the
            // shortest-range beam that sees it - the most specific answer.
            for (const zone of zones) {

                if (geometry.slantRangeM - target.radius > zone.range) {
                    continue;
                }

                if (geometry.elevationDeg + geometry.angularRadiusDeg < zone.minElevationDeg) {
                    continue;
                }

                if (geometry.elevationDeg - geometry.angularRadiusDeg > zone.maxElevationDeg) {
                    continue;
                }

                const blockDistance = CesiumRadarCoverage.terrainBlockDistance(
                    profiles.get(geometry.bearingDeg),
                    radarHeight,
                    geometry.elevationDeg,
                    zone.range
                );

                detections.push({
                    targetId: target.id,
                    targetName: target.name,
                    zoneName: zone.name,
                    slantRangeM: geometry.slantRangeM,
                    bearingDeg: geometry.bearingDeg,
                    elevationDeg: geometry.elevationDeg,
                    // The beam is cut short by the ridge before it gets there.
                    terrainShadowed: blockDistance < geometry.slantRangeM - target.radius
                });

                break;
            }
        }

        return detections;
    }

    // -------------------------------------------------------------------
    // Column sampling + adaptive refinement
    //
    // A uniform azimuth step cannot represent a terrain shadow edge: the edge
    // falls somewhere between two rays, and whatever the step, the pair that
    // straddles it disagrees wildly about how far the coverage reaches. So the
    // sector is first swept at the base step, and then any neighbouring pair
    // straddling a big range jump is split and re-traced, repeatedly, until the
    // jump is confined to a fraction of a degree. That is what puts the wall's
    // edge on the actual ridge silhouette instead of somewhere between two rays
    // that were degrees apart.
    // -------------------------------------------------------------------

    private static async buildZoneColumns(
        radarPosition: Cesium.Cartesian3,
        radarHeight: number,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        sectorStartDeg: number,
        sweepDeg: number,
        isFullCircle: boolean,
        baseStepDeg: number,
        refinementPasses: number,
        baseElevationRingsDeg: number[],
        profiles: TerrainProfileCache,
        objectDetector: CesiumObjectDetector | null,
        targets: DetectionTarget[],
        blockOnTargetBounds: boolean
    ): Promise<{ columns: ZoneColumn[]; elevationRingsDeg: number[] }> {

        const toAzimuth = (offset: number) => normalizeDegrees(sectorStartDeg + offset);

        const pickObjects = objectDetector !== null && !objectDetector.isEmpty;

        // Individual rays are cached by (azimuth offset, elevation), NOT whole
        // columns. Refinement adds azimuths AND elevations, and a per-column
        // cache would be thrown away whole every time a new elevation ring
        // appeared - re-tracing, and re-picking every model for, thousands of
        // rays that had not changed. Keyed per ray, a new ring only traces that
        // ring and a new azimuth only traces that azimuth.
        const rayCache = new Map<string, TracedRay>();

        const traceRay = (offset: number, elevationDeg: number): TracedRay => {

            const key = `${offset.toFixed(4)}|${elevationDeg.toFixed(4)}`;
            const cached = rayCache.get(key);

            if (cached) {
                return cached;
            }

            const azimuthDeg = toAzimuth(offset);
            const ray = makeRay(radarPosition, enuMatrix, azimuthDeg, elevationDeg);

            const terrainDistance = CesiumRadarCoverage.terrainBlockDistance(
                profiles.get(azimuthDeg),
                radarHeight,
                elevationDeg,
                zone.range
            );

            const objectDistance = pickObjects
                ? objectDetector!.getFirstObjectHit(ray, zone.range)
                : Number.POSITIVE_INFINITY;

            // Clipped HERE rather than in the ray overlay, because the overlay
            // is not the only thing that would go on drawing past the object.
            // The fill volume, the wireframe, the footprint and the stop marks
            // are all built from these same columns, so shortening the column
            // is what makes every one of them agree; shortening only the drawn
            // lines would have left the beam's surface sailing through an
            // obstacle that the lines stopped at.
            const boundsDistance = blockOnTargetBounds
                ? CesiumRadarCoverage.targetBoundsBlockDistance(ray, targets, zone.range)
                : Number.POSITIVE_INFINITY;

            const stoppedByObject = Math.min(objectDistance, boundsDistance);

            const distance = Math.min(terrainDistance, stoppedByObject, zone.range);

            // An object wins ties: if terrain and an object stop a ray at the
            // same distance the object is the more specific answer.
            const cause = stoppedByObject <= terrainDistance && stoppedByObject < zone.range
                ? StopCause.Object
                : (terrainDistance < zone.range ? StopCause.Terrain : StopCause.Range);

            const traced: TracedRay = {
                point: Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3()),
                distance,
                hitObject: cause === StopCause.Object,
                cause
            };

            rayCache.set(key, traced);

            return traced;
        };

        const buildColumns = (offsets: number[], rings: number[]): ZoneColumn[] =>
            offsets.map(offset => {

                const points: Cesium.Cartesian3[] = [];
                const distances: number[] = [];
                const objectHits: boolean[] = [];
                const causes: StopCause[] = [];

                for (const elevationDeg of rings) {
                    const traced = traceRay(offset, elevationDeg);
                    points.push(traced.point);
                    distances.push(traced.distance);
                    objectHits.push(traced.hitObject);
                    causes.push(traced.cause);
                }

                return {
                    offset,
                    azimuthDeg: toAzimuth(offset),
                    points,
                    distances,
                    objectHits,
                    causes
                };
            });

        let offsets = CesiumRadarCoverage.buildOffsetList(
            sectorStartDeg,
            sweepDeg,
            baseStepDeg,
            isFullCircle
        );

        let rings = [...baseElevationRingsDeg];

        // Sample the beam AT each target's silhouette before anything else.
        //
        // Relying on refinement alone to find an object is a gamble: refinement
        // only splits a pair of rays that already disagree, so an object sitting
        // entirely between two rays makes them agree perfectly and is never
        // found - the beam closes over it and, with the debug overlay on, rays
        // appear to pass straight through it. Seeding puts rays on its edges by
        // construction, so the beam is cut around its real outline.
        const seeds = CesiumRadarCoverage.targetSeedAngles(
            targets,
            zone,
            radarPosition,
            enuMatrix,
            sectorStartDeg,
            sweepDeg,
            isFullCircle
        );

        offsets = CesiumRadarCoverage.mergeAngles(offsets, seeds.offsets);
        rings = CesiumRadarCoverage.mergeAngles(rings, seeds.elevations);

        await profiles.ensure(offsets.map(toAzimuth));

        let columns = buildColumns(offsets, rings);

        const shadowStep = CesiumRadarCoverage.shadowStepFor(zone);

        // Refinement runs in BOTH axes. Azimuth alone cannot resolve a compact
        // obstacle: a building 60m across at 5km spans about half a degree
        // horizontally and less than that vertically, so with rings four degrees
        // apart it falls entirely between two of them and the beam closes over
        // it however finely the azimuths are split.
        for (let pass = 0; pass < refinementPasses; pass++) {

            const azimuthInserts = CesiumRadarCoverage.findAzimuthSplits(
                columns,
                isFullCircle,
                shadowStep,
                MAX_COLUMNS_PER_ZONE - columns.length
            );

            const elevationInserts = CesiumRadarCoverage.findElevationSplits(
                columns,
                rings,
                shadowStep,
                MAX_RINGS_PER_ZONE - rings.length
            );

            if (azimuthInserts.length === 0 && elevationInserts.length === 0) {
                break;
            }

            if (azimuthInserts.length > 0) {
                await profiles.ensure(azimuthInserts.map(toAzimuth));
                offsets = [...offsets, ...azimuthInserts].sort((a, b) => a - b);
            }

            if (elevationInserts.length > 0) {
                rings = [...rings, ...elevationInserts].sort((a, b) => a - b);
            }

            columns = buildColumns(offsets, rings);
        }

        return { columns, elevationRingsDeg: rings };
    }

    /**
     * Sample angles that land on each target's silhouette: a spread across its
     * angular width in azimuth, and the same up its angular height.
     */
    private static targetSeedAngles(
        targets: DetectionTarget[],
        zone: ResolvedZone,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        sectorStartDeg: number,
        sweepDeg: number,
        isFullCircle: boolean
    ): { offsets: number[]; elevations: number[] } {

        const offsets: number[] = [];
        const elevations: number[] = [];

        for (const target of targets) {

            const geometry = targetGeometry(radarPosition, enuMatrix, target);

            // Beyond this zone's reach, or outside its sector entirely.
            if (geometry.slantRangeM - target.radius > zone.range) {
                continue;
            }

            if (!isWithinSector(
                geometry.bearingDeg,
                sectorStartDeg,
                sweepDeg,
                geometry.angularRadiusDeg
            )) {
                continue;
            }

            const spread = Math.max(geometry.angularRadiusDeg, MIN_TARGET_SEED_RADIUS_DEG);
            const centreOffset = normalizeDegrees(geometry.bearingDeg - sectorStartDeg);

            for (const fraction of TARGET_SEED_FRACTIONS) {

                const offset = centreOffset + fraction * spread;

                if (isFullCircle) {
                    offsets.push(normalizeDegrees(offset));
                } else if (offset >= 0 && offset <= sweepDeg) {
                    offsets.push(offset);
                }

                const elevation = geometry.elevationDeg + fraction * spread;

                if (elevation >= zone.minElevationDeg && elevation <= zone.maxElevationDeg) {
                    elevations.push(elevation);
                }
            }
        }

        return { offsets, elevations };
    }

    /**
     * Adds angles to a sorted list, dropping any that land on one already there.
     * Near-duplicates would only add zero-width quads to the mesh.
     */
    private static mergeAngles(existing: number[], additions: number[]): number[] {

        if (additions.length === 0) {
            return existing;
        }

        const merged = [...existing];

        for (const angle of [...additions].sort((a, b) => a - b)) {

            const clash = merged.some(
                present => Math.abs(present - angle) < ANGLE_MERGE_EPSILON_DEG
            );

            if (!clash) {
                merged.push(angle);
            }
        }

        return merged.sort((a, b) => a - b);
    }

    /** True when anything in this column was stopped by an object, not terrain. */
    private static touchesObject(column: ZoneColumn): boolean {
        return column.objectHits.some(Boolean);
    }

    /**
     * Orders split candidates for a limited budget.
     *
     * Edges caused by an object come first, however small their range jump.
     * A mountain horizon offers far more diverging pairs than the budget can
     * pay for, and sorting on raw divergence alone lets those ridges - which
     * are already drawn acceptably at the base step - crowd out the handful of
     * splits that decide whether the beam closes over a building or cuts around
     * it. Within each group the biggest jump still wins.
     */
    private static orderSplits<T extends { divergence: number; onObject: boolean }>(
        candidates: T[],
        budget: number
    ): T[] {

        if (candidates.length <= budget) {
            return candidates;
        }

        candidates.sort((a, b) => {
            if (a.onObject !== b.onObject) {
                return a.onObject ? -1 : 1;
            }
            return b.divergence - a.divergence;
        });

        return candidates.slice(0, budget);
    }

    /**
     * Midpoint offsets for neighbouring columns that disagree about range by
     * more than a shadow edge, worst first when the budget cannot take them all.
     */
    private static findAzimuthSplits(
        columns: ZoneColumn[],
        isFullCircle: boolean,
        shadowStep: number,
        budget: number
    ): number[] {

        if (budget <= 0) {
            return [];
        }

        const candidates: { offset: number; divergence: number; onObject: boolean }[] = [];
        const pairCount = isFullCircle ? columns.length : columns.length - 1;

        for (let i = 0; i < pairCount; i++) {

            const current = columns[i];
            const next = columns[(i + 1) % columns.length];

            // On the wrapping pair the next column sits a full turn ahead, so
            // unwrap it before taking the midpoint.
            const nextOffset = i + 1 === columns.length
                ? next.offset + 360
                : next.offset;

            if (nextOffset - current.offset < MIN_REFINED_AZIMUTH_STEP_DEG * 2) {
                continue;
            }

            const divergence = CesiumRadarCoverage.columnDivergence(current, next);

            if (divergence <= shadowStep) {
                continue;
            }

            // Midpoints stay inside [0, sweep] by construction: a sector has no
            // wrapping pair, and on a full circle the first offset is always 0,
            // so the wrapping midpoint is (last + 360) / 2, which is under 360.
            candidates.push({
                offset: (current.offset + nextOffset) / 2,
                divergence,
                onObject:
                    CesiumRadarCoverage.touchesObject(current) ||
                    CesiumRadarCoverage.touchesObject(next)
            });
        }

        return CesiumRadarCoverage.orderSplits(candidates, budget)
            .map(candidate => candidate.offset);
    }

    /**
     * The same rule up the beam instead of across it: an elevation band whose
     * two rings disagree about range - in ANY column - is split. Rings are
     * shared by every column, so the sampling grid stays rectangular and the
     * meshing code is unaffected.
     */
    private static findElevationSplits(
        columns: ZoneColumn[],
        rings: number[],
        shadowStep: number,
        budget: number
    ): number[] {

        if (budget <= 0 || rings.length < 2) {
            return [];
        }

        const candidates: { elevation: number; divergence: number; onObject: boolean }[] = [];

        for (let r = 0; r < rings.length - 1; r++) {

            if (rings[r + 1] - rings[r] < MIN_REFINED_ELEVATION_STEP_DEG * 2) {
                continue;
            }

            let worst = 0;
            let onObject = false;

            for (const column of columns) {

                worst = Math.max(worst, Math.abs(column.distances[r] - column.distances[r + 1]));

                if (column.objectHits[r] || column.objectHits[r + 1]) {
                    onObject = true;
                }
            }

            if (worst <= shadowStep) {
                continue;
            }

            candidates.push({
                elevation: (rings[r] + rings[r + 1]) / 2,
                divergence: worst,
                onObject
            });
        }

        return CesiumRadarCoverage.orderSplits(candidates, budget)
            .map(candidate => candidate.elevation);
    }

    /**
     * How far two neighbouring ranges may differ before they are treated as
     * opposite sides of a shadow edge rather than as one continuous surface.
     */
    private static shadowStepFor(zone: ResolvedZone): number {
        return Math.max(SHADOW_EDGE_MIN_STEP_M, zone.range * SHADOW_EDGE_RANGE_FRACTION);
    }

    /** Largest range disagreement between two columns, over all elevation rings. */
    private static columnDivergence(a: ZoneColumn, b: ZoneColumn): number {

        let worst = 0;

        for (let r = 0; r < a.distances.length; r++) {
            worst = Math.max(worst, Math.abs(a.distances[r] - b.distances[r]));
        }

        return worst;
    }

    /**
     * joins[c] is true when column c and column c+1 are close enough in range to
     * be joined into one wall. Where it is false the two rays landed on opposite
     * sides of a blockage, and bridging them would draw a face from the near hit
     * point out to the far one - the sheet that appears to lie across the valley
     * or slice through the ridge between them. So the wall simply ends, and each
     * side closes with its own end wall instead.
     */
    private static computeJoins(
        zone: ResolvedZone,
        columns: ZoneColumn[],
        isFullCircle: boolean
    ): { surface: boolean[]; shadowEdge: boolean[] } {

        const shadowStep = CesiumRadarCoverage.shadowStepFor(zone);

        const maxCurtainJump = Math.max(
            MIN_CURTAIN_JUMP_M,
            zone.range * MAX_CURTAIN_JUMP_RANGE_FRACTION
        );

        const pairCount = isFullCircle ? columns.length : Math.max(0, columns.length - 1);

        // Two different questions, which used to share one answer and should not.
        //
        // shadowEdge: do these two rays disagree about how far the beam reaches?
        //   Used by the wireframe, which must NOT draw a bright line from a
        //   blocked ray to an unblocked one.
        //
        // surface: should the fill close across them? Yes even at a shadow edge,
        //   as long as refinement has made the edge narrow - that closing quad
        //   is the wall at the blockage. Treating every shadow edge as a hole
        //   left the beam open at exactly the place it was supposed to stop, so
        //   it appeared to sail straight past whatever had blocked it.
        const surface: boolean[] = [];
        const shadowEdge: boolean[] = [];

        for (let c = 0; c < pairCount; c++) {

            const current = columns[c];
            const next = columns[(c + 1) % columns.length];

            const nextOffset = c + 1 === columns.length
                ? next.offset + 360
                : next.offset;

            const jump = CesiumRadarCoverage.columnDivergence(current, next);
            const diverges = jump > shadowStep;

            shadowEdge.push(diverges);

            surface.push(
                !diverges || (
                    (nextOffset - current.offset) <= MAX_CURTAIN_GAP_DEG &&
                    jump <= maxCurtainJump
                )
            );
        }

        return { surface, shadowEdge };
    }

    /** True when nothing is joined to this column on its lower-azimuth side. */
    private static isOpenBefore(c: number, joins: boolean[], colCount: number, isFullCircle: boolean): boolean {
        if (isFullCircle) {
            return !joins[(c - 1 + colCount) % colCount];
        }
        return c === 0 ? true : !joins[c - 1];
    }

    /** True when nothing is joined to this column on its higher-azimuth side. */
    private static isOpenAfter(c: number, joins: boolean[], colCount: number, isFullCircle: boolean): boolean {
        if (isFullCircle) {
            return !joins[c];
        }
        return c === colCount - 1 ? true : !joins[c];
    }

    /**
     * Walks one azimuth's ground profile and returns the slant distance at which
     * terrain first cuts the beam, or the zone range if it never does.
     *
     * Ray height is computed analytically rather than by converting a sampled
     * 3D point: height = radar height + horizontal x tan(elevation), minus the
     * earth-curvature drop. That keeps the whole scan to plain arithmetic, which
     * is what makes metre-scale sampling affordable.
     */
    /**
     * Distance at which a ray first enters any target's bounding sphere.
     *
     * This is a DELIBERATELY COARSE stand-in for tracing the model's triangles.
     * It stops the beam at a sphere around the object rather than at the
     * object's real silhouette, so the void it leaves is rounder and wider than
     * the thing that cast it. It is here because it depends only on the target
     * list - the same list detection is solved from, and the same list that is
     * demonstrably working when an object lights up - so it keeps working when
     * triangle-level blocking does not.
     *
     * A ray whose ORIGIN is already inside a sphere is not blocked by it. That
     * is not a detail: an obstacle placed on top of the antenna contains the
     * antenna, every ray would start inside it, and blocking them all at zero
     * would delete the entire beam rather than take a bite out of it.
     */
    private static targetBoundsBlockDistance(
        ray: Cesium.Ray,
        targets: DetectionTarget[],
        maxDistance: number
    ): number {

        let nearest = Number.POSITIVE_INFINITY;

        for (const target of targets) {

            scratchTargetSphere.center = target.position;
            scratchTargetSphere.radius = target.radius;

            const interval = Cesium.IntersectionTests.raySphere(
                ray,
                scratchTargetSphere,
                scratchTargetInterval
            );

            // No hit, or the antenna stands inside this target - see above.
            if (!interval || interval.start <= 0) {
                continue;
            }

            if (interval.start < nearest && interval.start <= maxDistance) {
                nearest = interval.start;
            }
        }

        return nearest;
    }

    private static terrainBlockDistance(
        profile: TerrainProfile,
        radarHeight: number,
        elevationDeg: number,
        maxRange: number
    ): number {

        const elevation = Cesium.Math.toRadians(elevationDeg);
        const cosElevation = Math.cos(elevation);

        // Pointing (near enough) straight up - nothing can block it.
        if (cosElevation < 1e-6) {
            return maxRange;
        }

        const tanElevation = Math.tan(elevation);
        const maxHorizontal = maxRange * cosElevation;

        const { horizontalDistances, groundHeights } = profile;

        let previousHorizontal = horizontalDistances[0];
        let previousClearance = radarHeight - groundHeights[0];

        for (let i = 1; i < horizontalDistances.length; i++) {

            const horizontal = horizontalDistances[i];

            if (horizontal > maxHorizontal) {
                break;
            }

            // PLUS the curvature term, not minus.
            //
            // Ground heights here are heights above the ellipsoid, and a
            // straight ray GAINS height above the ellipsoid with distance,
            // because the surface curves away beneath it - a horizontal ray is
            // h^2/2R above the ellipsoid after h metres. Subtracting it instead
            // models a ray sagging towards a flat earth, which is the wrong
            // frame to compare ellipsoidal heights in, and it is wrong by
            // h^2/R: about 63m at 20km.
            //
            // At the default mast height of 0 it was catastrophic rather than
            // merely inaccurate. The radar sits ON the ground, so a zero
            // elevation ray starts with no clearance at all, and the sagging
            // term put it below ground at the very first sample - every
            // horizontal ray was blocked within a few tens of metres of the
            // antenna, over terrain that was perfectly flat.
            const rayHeight =
                radarHeight +
                horizontal * tanElevation +
                (horizontal * horizontal) / (2 * EARTH_RADIUS_M);

            const clearance = rayHeight - groundHeights[i];

            if (clearance > 0) {
                previousHorizontal = horizontal;
                previousClearance = clearance;
                continue;
            }

            // Terrain crossed between the last clear sample and this one.
            const drop = previousClearance - clearance;

            const fraction = drop > 0
                ? Cesium.Math.clamp(previousClearance / drop, 0, 1)
                : 0;

            const blockHorizontal =
                previousHorizontal + fraction * (horizontal - previousHorizontal);

            return blockHorizontal / cosElevation;
        }

        return maxRange;
    }

    // -------------------------------------------------------------------
    // Filled coverage volume.
    //
    // Joined neighbours become one continuous wall, with a cap over the top of
    // the beam and a cap underneath when the beam starts above the horizontal.
    // Where neighbours are NOT joined the wall stops, and the columns on either
    // side of the break each close with their own end wall - the fan back to the
    // antenna through that one azimuth's ray endpoints. That fan lies along the
    // rays themselves, which are clear all the way to where they stopped, so
    // unlike a bridge across the break it cannot lie over the valley or cut
    // through the ridge.
    // -------------------------------------------------------------------

    private static buildMeshPrimitive(
        zone: ResolvedZone,
        columns: ZoneColumn[],
        joins: boolean[],
        shadowEdge: boolean[],
        elevationRingsDeg: number[],
        isFullCircle: boolean,
        radarPosition: Cesium.Cartesian3,
        entityId: string,
        beamOpacity: number
    ): Cesium.Primitive | null {

        const ringCount = elevationRingsDeg.length;
        const colCount = columns.length;

        if (ringCount < 2 || colCount < 2) {
            return null;
        }

        const shadowStep = CesiumRadarCoverage.shadowStepFor(zone);

        const positionValues: number[] = [];

        for (const column of columns) {
            for (const point of column.points) {
                positionValues.push(point.x, point.y, point.z);
            }
        }

        // Apex vertex, shared by the top cap, the bottom cap and the end walls.
        const apexIndex = colCount * ringCount;
        positionValues.push(radarPosition.x, radarPosition.y, radarPosition.z);

        const indexOf = (col: number, ring: number) => col * ringCount + ring;

        const indices: number[] = [];

        // Outer surface and caps, across joined pairs only.
        for (let c = 0; c < joins.length; c++) {

            if (!joins[c]) {
                continue;
            }

            const cNext = (c + 1) % colCount;

            for (let r = 0; r < ringCount - 1; r++) {
                const i00 = indexOf(c, r);
                const i01 = indexOf(cNext, r);
                const i10 = indexOf(c, r + 1);
                const i11 = indexOf(cNext, r + 1);

                indices.push(i00, i10, i11);
                indices.push(i00, i11, i01);
            }

            // Top cap: the upper boundary of the beam is a cone from the antenna.
            indices.push(apexIndex, indexOf(c, ringCount - 1), indexOf(cNext, ringCount - 1));

            // Bottom cap, only when the beam starts above the horizontal. At 0
            // elevation the bottom of the volume IS the terrain, and a cap there
            // would be a flat sheet cutting through every hill it crosses -
            // which is exactly what the old ground footprint did.
            if (zone.minElevationDeg > 0.01) {
                indices.push(apexIndex, indexOf(cNext, 0), indexOf(c, 0));
            }
        }

        // Caps. Wherever the surface broke - a sector end, or a jump too long to
        // close with a curtain - the column is sealed with a fan back to the
        // antenna, so the beam ENDS there rather than stopping in an open edge
        // that the eye reads straight through.
        //
        // Only at breaks, which the range cap above now makes comparatively few.
        // Drawing one of these per shadow edge, as an earlier version did, put
        // hundreds of radial sheets between the eye and the ground and turned
        // the beam into a solid block of colour.
        for (let c = 0; c < colCount; c++) {

            const isSectorEdge = !isFullCircle && (c === 0 || c === colCount - 1);

            const broken =
                CesiumRadarCoverage.isOpenBefore(c, joins, colCount, isFullCircle) ||
                CesiumRadarCoverage.isOpenAfter(c, joins, colCount, isFullCircle);

            if (!isSectorEdge && !broken) {
                continue;
            }

            const distances = columns[c].distances;

            for (let r = 0; r < ringCount - 1; r++) {

                // The same break rule, applied up the column: a ring that clears
                // a ridge while the ring below it is stopped short is its own
                // cliff, and bridging those two is the same mistake vertically.
                if (Math.abs(distances[r] - distances[r + 1]) > shadowStep) {
                    continue;
                }

                indices.push(apexIndex, indexOf(c, r), indexOf(c, r + 1));
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const meshAttributes = new Cesium.GeometryAttributes();
        meshAttributes.position = new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positionValues)
        });

        const geometry = new Cesium.Geometry({
            attributes: meshAttributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positionValues)
        });

        const instance = new Cesium.GeometryInstance({
            geometry,
            id: { radarParentId: entityId },
            attributes: {
                // Low, because a full-circle zone puts its near wall, far wall
                // and top cap between the eye and the ground, and three nested
                // zones stack about a dozen such layers. The wireframe carries
                // the definition; the fill only has to say "covered".
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    zone.color.withAlpha(Cesium.Math.clamp(beamOpacity, 0, 1))
                )
            }
        });

        return new Cesium.Primitive({
            geometryInstances: instance,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                closed: false,
                renderState: {
                    // Both sides: you are looking at a translucent volume, so the
                    // far wall has to be visible through the near one.
                    cull: { enabled: false },
                    // Depth TEST on so terrain occludes the parts of the volume
                    // buried in a hill; depth WRITE off so the volume's own faces
                    // do not occlude each other and produce hard banding.
                    depthTest: { enabled: true },
                    depthMask: false,
                    blending: Cesium.BlendingState.ALPHA_BLEND
                }
            }),
            asynchronous: false
        });
    }

    // -------------------------------------------------------------------
    // The faces of the bite an object takes out of the beam, drawn as their own
    // primitive in their own colour.
    //
    // The beam already closes correctly around an obstacle - the surface dips in
    // to it and back out. But a dent in a surface drawn at 0.12 alpha is
    // invisible, which is why the beam kept looking as though it had sailed
    // straight through. These are the same faces, drawn far more strongly and
    // in a colour nothing else uses, so the cut reads at a glance.
    // -------------------------------------------------------------------

    private static buildObjectShadowPrimitive(
        columns: ZoneColumn[],
        ringCount: number,
        isFullCircle: boolean,
        entityId: string
    ): Cesium.Primitive | null {

        const colCount = columns.length;

        if (ringCount < 2 || colCount < 2) {
            return null;
        }

        const positionValues: number[] = [];

        for (const column of columns) {
            for (const point of column.points) {
                positionValues.push(point.x, point.y, point.z);
            }
        }

        const indexOf = (col: number, ring: number) => col * ringCount + ring;

        const indices: number[] = [];
        const pairCount = isFullCircle ? colCount : colCount - 1;

        for (let c = 0; c < pairCount; c++) {

            const cNext = (c + 1) % colCount;
            const here = columns[c];
            const next = columns[cNext];

            for (let r = 0; r < ringCount - 1; r++) {

                // Any corner stopped by an object makes this a face of the bite.
                const onObject =
                    here.objectHits[r] || here.objectHits[r + 1] ||
                    next.objectHits[r] || next.objectHits[r + 1];

                if (!onObject) {
                    continue;
                }

                const i00 = indexOf(c, r);
                const i01 = indexOf(cNext, r);
                const i10 = indexOf(c, r + 1);
                const i11 = indexOf(cNext, r + 1);

                indices.push(i00, i10, i11);
                indices.push(i00, i11, i01);
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const attributes = new Cesium.GeometryAttributes();
        attributes.position = new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positionValues)
        });

        const geometry = new Cesium.Geometry({
            attributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positionValues)
        });

        const instance = new Cesium.GeometryInstance({
            geometry,
            id: { radarParentId: entityId },
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    STOP_COLOR_OBJECT.withAlpha(0.45)
                )
            }
        });

        return new Cesium.Primitive({
            geometryInstances: instance,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                closed: false,
                renderState: {
                    cull: { enabled: false },
                    depthTest: { enabled: true },
                    depthMask: false,
                    blending: Cesium.BlendingState.ALPHA_BLEND
                }
            }),
            asynchronous: false
        });
    }

    // -------------------------------------------------------------------
    // Edge overlay, drawn in an opaque, slightly stronger version of the zone
    // colour so the beam has a defined boundary against the terrain.
    //
    // In "solid" style only the beam's silhouette is drawn: its top and bottom
    // contours, its sector edges, and the edges where terrain cuts it short.
    // The internal ring/rib grid is left out on purpose - a lattice of lines
    // through the volume reads as a bundle of separate rays rather than as one
    // beam, which is exactly the look this replaces. "lattice" restores it for
    // when the sampling structure itself is what you want to see.
    //
    // Either way these lines break wherever the wall breaks: a bright line
    // drawn from a blocked ray to an unblocked one is the single most
    // misleading thing on screen, because it reads as a beam crossing the ridge
    // rather than as the edge of a shadow.
    // -------------------------------------------------------------------

    private static buildWireframePrimitive(
        zone: ResolvedZone,
        columns: ZoneColumn[],
        shadowEdge: boolean[],
        ringCount: number,
        isFullCircle: boolean,
        entityId: string,
        beamStyle: "solid" | "lattice"
    ): Cesium.Primitive | null {

        const colCount = columns.length;

        if (ringCount < 1 || colCount < 2) {
            return null;
        }

        const positionValues: number[] = [];

        for (const column of columns) {
            for (const point of column.points) {
                positionValues.push(point.x, point.y, point.z);
            }
        }

        const indexOf = (col: number, ring: number) => col * ringCount + ring;

        const indices: number[] = [];

        const solid = beamStyle === "solid";

        // Contours around the beam. Solid style keeps only the top and bottom
        // edges; lattice draws every ring.
        const contourRings = solid
            ? (ringCount > 1 ? [0, ringCount - 1] : [0])
            : Array.from({ length: ringCount }, (_, r) => r);

        // shadowEdge[c] is true where the pair DISAGREES, so a contour is drawn
        // only where they agree - the inverse of the fill, which deliberately
        // closes across a narrow shadow edge to form the wall there.
        const joined = shadowEdge.map(edge => !edge);

        for (let c = 0; c < joined.length; c++) {

            if (!joined[c]) {
                continue;
            }

            const cNext = (c + 1) % colCount;

            for (const r of contourRings) {
                indices.push(indexOf(c, r), indexOf(cNext, r));
            }
        }

        // Ribs: the beam's vertical edges.
        //
        // A rib runs from where that azimuth's lowest ray stopped - on the
        // ground - out and up to where its highest ray reached, which over a
        // long range is far away and high in the air. Drawn from above it
        // projects right across the terrain and reads as a line tunnelling
        // through the hills, which is exactly what it is not.
        //
        // Broken terrain produces hundreds of shadow edges, so putting a rib on
        // every one buried the view in those lines. In solid style ribs are now
        // kept for the two sector edges and for shadow edges an OBJECT caused -
        // few, and the ones actually worth pointing out. The closing curtain in
        // the fill already marks where terrain cut the beam.
        const ribbed = new Set<number>();

        if (!solid) {
            const ribStride = Math.max(1, Math.round(colCount / WIREFRAME_TARGET_RIBS));

            for (let c = 0; c < colCount; c += ribStride) {
                ribbed.add(c);
            }
        }

        for (let c = 0; c < colCount; c++) {

            const open =
                CesiumRadarCoverage.isOpenBefore(c, joined, colCount, isFullCircle) ||
                CesiumRadarCoverage.isOpenAfter(c, joined, colCount, isFullCircle);

            if (!open) {
                continue;
            }

            const isSectorEdge = !isFullCircle && (c === 0 || c === colCount - 1);

            if (solid && !isSectorEdge && !CesiumRadarCoverage.touchesObject(columns[c])) {
                continue;
            }

            ribbed.add(c);
        }

        for (const c of ribbed) {
            for (let r = 0; r < ringCount - 1; r++) {
                indices.push(indexOf(c, r), indexOf(c, r + 1));
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const wireAttributes = new Cesium.GeometryAttributes();
        wireAttributes.position = new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positionValues)
        });

        const geometry = new Cesium.Geometry({
            attributes: wireAttributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.LINES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positionValues)
        });

        const instance = new Cesium.GeometryInstance({
            geometry,
            id: { radarParentId: entityId },
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(zone.color.withAlpha(0.8))
            }
        });

        return new Cesium.Primitive({
            geometryInstances: instance,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                renderState: {
                    lineWidth: 1,
                    depthTest: { enabled: true },
                    depthMask: false,
                    blending: Cesium.BlendingState.ALPHA_BLEND
                }
            }),
            asynchronous: false
        });
    }

    // -------------------------------------------------------------------
    // Ground footprint: the illuminated ground, DRAPED on the terrain.
    //
    // This used to be a polygon with perPositionHeight, which is what produced
    // the green shards. Cesium triangulates such a polygon in a plane and then
    // draws those triangles in 3D, so a triangle with one corner on each side
    // of a valley is drawn as a flat sheet spanning straight through the hill
    // between them. Clamping to terrain instead makes the fill follow the
    // ground exactly and it can never cut through anything.
    // -------------------------------------------------------------------

    private static buildGroundFootprint(
        viewer: Cesium.Viewer,
        zone: ResolvedZone,
        columns: ZoneColumn[],
        isFullCircle: boolean,
        radarPosition: Cesium.Cartesian3,
        entityId: string
    ): Cesium.Entity[] {

        // The beam only lights the ground if its lowest ring is at (or below)
        // the horizontal. A zone starting at 10 degrees up illuminates air.
        if (zone.minElevationDeg > 0.5 || columns.length < 3) {
            return [];
        }

        const boundary = columns.map(column => column.points[0]);

        const ring = isFullCircle ? boundary : [radarPosition, ...boundary];

        // A radar walled in at point-blank range collapses every hit point onto
        // the antenna, which is not a polygon.
        if (CesiumRadarCoverage.distinctPositionCount(ring) < 3) {
            return [];
        }

        const created: Cesium.Entity[] = [];

        // Draping needs a stencil buffer. Without one, Cesium throws rather than
        // degrading, and an unclamped fallback would be the flat sheet cutting
        // through hillsides that this replaced - so the fill is simply skipped.
        if (Cesium.GroundPrimitive.isSupported(viewer.scene)) {

            const fill = viewer.entities.add({
                name: `${zone.name} ground footprint`,
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(ring),
                    material: zone.color.withAlpha(0.18),
                    // Drape over terrain. Deliberately no perPositionHeight and
                    // no height - either turns this back into a flat sheet.
                    classificationType: Cesium.ClassificationType.TERRAIN
                }
            });

            (fill as any).radarParentId = entityId;
            created.push(fill);
        }

        // Outline as a separate ground-clamped polyline: a clamped polygon
        // cannot carry its own outline, and an unclamped one would float.
        if (Cesium.GroundPolylinePrimitive.isSupported(viewer.scene)) {

            const outline = viewer.entities.add({
                name: `${zone.name} ground footprint outline`,
                polyline: {
                    positions: [...ring, ring[0]],
                    width: 2,
                    material: zone.color.withAlpha(0.9),
                    clampToGround: true
                }
            });

            (outline as any).radarParentId = entityId;
            created.push(outline);
        }

        return created;
    }

    /** Positions further apart than a metre, so a degenerate ring is caught. */
    private static distinctPositionCount(positions: Cesium.Cartesian3[]): number {

        let count = 0;

        for (let i = 0; i < positions.length; i++) {
            const previous = positions[i === 0 ? positions.length - 1 : i - 1];

            if (Cesium.Cartesian3.distance(previous, positions[i]) > 1) {
                count++;
            }
        }

        return count;
    }

    // -------------------------------------------------------------------
    // Optional debug ray overlay. Reuses the same columns as the beam mesh, so
    // the rays land exactly on the beam surface instead of forming a separately
    // sampled - and therefore misaligned - fan. Every ray is drawn: the point of
    // the overlay is to show the real sampling density, and decimating it made a
    // finely refined beam look like a handful of stray lines.
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // Ray overlay: where every sampled ray ended, and what ended it.
    //
    // Coloured by cause rather than by zone, because the question this answers
    // is "was this ray stopped, or did it just run out of range?" - and a fan
    // drawn in one colour cannot say. Terrain stops are amber, object stops are
    // red and thicker, and rays that reached full range are dimmed so the
    // blocked ones stand out against them.
    //
    // Every stopped ray also gets a dot exactly where it stopped. The dots are
    // drawn whether or not the lines are, so the cut an obstacle makes in the
    // beam can be seen without turning the whole fan on.
    // -------------------------------------------------------------------

    private static buildRayOverlay(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        zone: ResolvedZone,
        columns: ZoneColumn[],
        ringCount: number,
        drawLines: boolean,
        markObjectStops: boolean
    ): { dispose(): void } | null {

        const polylines = drawLines ? new Cesium.PolylineCollection() : null;
        const points = new Cesium.PointPrimitiveCollection();

        // Lines are capped; the stop dots are not, because they only exist for
        // rays that were actually stopped, which is a small fraction.
        const total = columns.length * ringCount;
        const stride = Math.max(1, Math.ceil(total / MAX_DEBUG_RAYS_PER_ZONE));

        // Lines stay in the ZONE's colour, whatever stopped them.
        //
        // Colouring the lines by cause instead made a single selected zone look
        // like several: amber terrain-stopped rays among green clear ones read
        // as another zone's beam rather than as the same beam being cut. Zone
        // identity belongs to the line; what stopped it belongs to the dot at
        // its end. Blocked rays are still drawn brighter and thicker, so the
        // shadow an obstacle casts is readable without a second colour.
        const clearMaterial = Cesium.Material.fromType("Color", {
            color: zone.color.withAlpha(0.22)
        });
        const terrainMaterial = Cesium.Material.fromType("Color", {
            color: zone.color.withAlpha(0.7)
        });
        const objectMaterial = Cesium.Material.fromType("Color", {
            color: zone.color.withAlpha(1.0)
        });

        for (let c = 0; c < columns.length; c++) {

            const column = columns[c];
            const drawThisColumn = drawLines && c % stride === 0;

            for (let r = 0; r < ringCount; r++) {

                const cause = column.causes[r];
                const endPoint = column.points[r];

                if (drawThisColumn) {
                    polylines!.add({
                        positions: [radarPosition, endPoint],
                        // A stopped ray is drawn brighter and thicker than one
                        // that simply ran out of range, so the shadow an
                        // obstacle casts reads at a glance.
                        width: cause === StopCause.Object ? 2 : 1,
                        material: cause === StopCause.Object
                            ? objectMaterial
                            : (cause === StopCause.Terrain ? terrainMaterial : clearMaterial)
                    });
                }

                if (cause === StopCause.Range) {
                    continue;
                }

                if (cause === StopCause.Object && !markObjectStops) {
                    continue;
                }

                points.add({
                    position: endPoint,
                    pixelSize: cause === StopCause.Object ? 8 : 3,
                    color: cause === StopCause.Object
                        ? STOP_COLOR_OBJECT
                        : STOP_COLOR_TERRAIN.withAlpha(0.7),
                    outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
                    outlineWidth: cause === StopCause.Object ? 2 : 0,
                    // Always on top. These dots sit INSIDE the translucent beam,
                    // which is painted over them by the time they would blend -
                    // so depth-testing them made the one thing you need to see
                    // the one thing you could not.
                    disableDepthTestDistance: cause === StopCause.Object
                        ? Number.POSITIVE_INFINITY
                        : 0
                });
            }
        }

        if (points.length === 0 && !polylines) {
            return null;
        }

        if (polylines) {
            viewer.scene.primitives.add(polylines);
        }

        viewer.scene.primitives.add(points);

        return {
            dispose: () => {
                if (polylines) viewer.scene.primitives.remove(polylines);
                viewer.scene.primitives.remove(points);
            }
        };
    }

    // -------------------------------------------------------------------
    // Sector helpers
    // -------------------------------------------------------------------

    /**
     * Angles from the sector's leading edge, in [0, sweep]. Working in offsets
     * rather than absolute azimuths keeps the list sorted through the 359 -> 0
     * seam, which is what lets refinement insert midpoints safely.
     *
     * The interior samples are pinned to a global grid of azimuths measured from
     * north, not to the sector's own edge. That way swinging the heading re-uses
     * almost every terrain profile already sampled, instead of landing on a
     * fresh set of azimuths and paying for the whole scan again. Only the two
     * sector edges move with the heading.
     */
    private static buildOffsetList(
        sectorStartDeg: number,
        sweepDeg: number,
        stepDeg: number,
        isFullCircle: boolean
    ): number[] {

        const step = Math.max(0.5, stepDeg);

        if (isFullCircle) {
            // The last column wraps onto the first, so 360 itself is not listed.
            const count = Math.max(8, Math.round(360 / step));
            return Array.from({ length: count }, (_, i) => (360 * i) / count);
        }

        const offsets: number[] = [0];

        // First grid azimuth strictly inside the sector, as an offset from its
        // leading edge.
        const firstGridOffset = Math.ceil(sectorStartDeg / step) * step - sectorStartDeg;

        for (let offset = firstGridOffset; offset < sweepDeg; offset += step) {
            if (offset > 0) {
                offsets.push(offset);
            }
        }

        offsets.push(sweepDeg);

        // A sector narrower than one grid step would otherwise be two edges and
        // nothing between them.
        if (offsets.length < 3) {
            return [0, sweepDeg / 2, sweepDeg];
        }

        return offsets;
    }

    private static buildElevationRings(
        minDeg: number,
        maxDeg: number,
        ringCount: number
    ): number[] {

        const count = Math.max(2, Math.round(ringCount));

        if (maxDeg <= minDeg) {
            return [minDeg, minDeg];
        }

        const rings: number[] = [];
        for (let i = 0; i < count; i++) {
            rings.push(minDeg + ((maxDeg - minDeg) * i) / (count - 1));
        }

        return rings;
    }
}
