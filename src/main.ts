import * as Cesium from "cesium";

// The lab imports the REAL radar source out of the main app rather than a copy.
// A sandbox that drifts from the code it is meant to exercise is worse than no
// sandbox at all: anything fixed here is fixed in on2, and anything broken here
// is broken there.
import {
    CesiumRadarCoverage,
    type RadarCoverageHandle,
    type RadarZoneOverride
} from "../../on2/src/app/components/cesium-map/CesiumRadarCoverage";

import {
    collectModelTargets,
    type Detection
} from "../../on2/src/app/components/cesium-map/CesiumRadarDetection";

import { CesiumObjectDetector } from "../../on2/src/app/components/cesium-map/CesiumObjectDetector";
import { CesiumGlbManager, type PlacedGlb } from "../../on2/src/app/components/cesium-map/CesiumGlbManager";

// Same token as the main app - same Ion account, same terrain.
Cesium.Ion.defaultAccessToken =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIxNzFhZjQzZC0xNGNmLTQyNDAtOTFlMC1jMmEyMDQwOTExNDAiLCJpZCI6NDQyMjYxLCJzdWIiOiJIYXJzaW1hcjA4IiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6Im1pc3Npb24iLCJpYXQiOjE3ODQwMDU4MjB9.NzxkVB0Hlz8uYySEa5PaSg7bycWumdeeUXiaJgk57XY";

// =============================================================================
// State
// =============================================================================

interface ZoneState {
    visible: boolean;
    range: number;
    maxElevationDeg: number;
    /**
     * Selected for inspection. The overlay switches - stop marks, individual
     * rays, sampling grid - apply only to selected zones.
     *
     * Separate from `visible`: three zones of rays at once is unreadable, but
     * hiding a zone to quieten the overlay would also remove the beam you were
     * trying to inspect.
     */
    selected: boolean;
}

interface RadarState {
    id: string;
    name: string;
    longitude: number;
    latitude: number;
    headingDeg: number;
    sectorSweepDeg: number;
    mastHeight: number;
    showLattice: boolean;
    drawRays: boolean;
    markBlockedRays: boolean;
    beamOpacity: number;
    zones: Map<string, ZoneState>;

    /**
     * The antenna dot, owned by the lab rather than by the coverage builder.
     *
     * The builder recreates its own marker on every rebuild, so the dot blinked
     * out for the length of each build and disappeared completely whenever every
     * beam was switched off or a build failed. This one is created once with the
     * radar and only ever moves, so the radar is always visible and always
     * clickable - even with all beams hidden.
     */
    marker: Cesium.Entity;

    handles: RadarCoverageHandle[];
    detections: Detection[];

    buildInFlight: boolean;
    rebuildQueued: boolean;
    lastBuildMs: number;
}

const radars: RadarState[] = [];
let selectedRadarId: string | null = null;
let nextRadarNumber = 1;

// =============================================================================
// Persistence
//
// Radars outlive a reload, the same as obstacles do. Losing a carefully placed
// set of radars to a refresh - while the obstacles they were aimed at survived -
// made the two halves of a scenario disagree every time the page was reloaded.
//
// localStorage rather than IndexedDB: this is a few hundred bytes of numbers,
// with none of the binary payload that made obstacles need a real database.
// =============================================================================

const RADAR_STORAGE_KEY = "radar-lab.radars.v1";

interface StoredRadar {
    name: string;
    longitude: number;
    latitude: number;
    headingDeg: number;
    sectorSweepDeg: number;
    mastHeight: number;
    showLattice: boolean;
    drawRays: boolean;
    markBlockedRays: boolean;
    beamOpacity: number;
    zones: Record<string, ZoneState>;
}

function saveRadars(): void {

    try {
        const stored: StoredRadar[] = radars.map(radar => ({
            name: radar.name,
            longitude: radar.longitude,
            latitude: radar.latitude,
            headingDeg: radar.headingDeg,
            sectorSweepDeg: radar.sectorSweepDeg,
            mastHeight: radar.mastHeight,
            showLattice: radar.showLattice,
            drawRays: radar.drawRays,
            markBlockedRays: radar.markBlockedRays,
            beamOpacity: radar.beamOpacity,
            zones: Object.fromEntries(radar.zones)
        }));

        localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(stored));
    } catch (err) {
        // A full or unavailable store must not break placing radars.
        console.warn("Could not save radars:", err);
    }
}

function loadStoredRadars(): StoredRadar[] {

    try {
        const raw = localStorage.getItem(RADAR_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.warn("Could not read saved radars:", err);
        return [];
    }
}

function defaultZones(): Map<string, ZoneState> {

    const zones = new Map<string, ZoneState>();

    for (const zone of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
        zones.set(zone.name, {
            visible: true,
            range: zone.defaultRange,
            maxElevationDeg: zone.defaultMaxElevationDeg,
            selected: true
        });
    }

    return zones;
}

const selectedRadar = () => radars.find(r => r.id === selectedRadarId) ?? null;

// =============================================================================
// Viewer
// =============================================================================

const terrainProvider = await Cesium.createWorldTerrainAsync();

const viewer = new Cesium.Viewer("cesium", {
    terrainProvider,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity
});

viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.fog.enabled = false;

const START = { longitude: 78.043865, latitude: 30.3401461 };

viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(START.longitude, START.latitude, 9000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 }
});

// =============================================================================
// Obstacles
// =============================================================================

const glbManager = new CesiumGlbManager(
    viewer,
    terrainProvider,
    () => rebuildAll(),
    () => renderObstacles()
);

/**
 * Every loaded GLB becomes a detection target.
 *
 * Detection is analytic - the builder solves each target's exact bearing,
 * elevation and range and then checks terrain line of sight - so a target far
 * smaller than the gap between two beam-sampling rays is still found. A search
 * of the ray grid could only ever see objects about as big as its own step.
 */
function detectionTargets() {
    return collectModelTargets(viewer, model => {
        const placed = glbManager.findByModel(model);
        return placed
            ? { id: placed.id, name: placed.name }
            : { id: "scene-model", name: "scene model" };
    });
}

// =============================================================================
// Detection highlight
// =============================================================================

const ZONE_COLORS = new Map(
    CesiumRadarCoverage.DEFAULT_3D_ZONES.map(zone => [zone.name, zone.color])
);

/**
 * Paints a silhouette round every model a beam currently holds, in the colour of
 * the zone that holds it.
 *
 * A row in the side panel is easy to miss when you are looking at the terrain,
 * and it cannot tell you WHICH of two similar models was seen. The silhouette is
 * drawn by Cesium in screen space, so it reads through the translucent beam and
 * from any angle.
 *
 * Detections from every radar are merged: an object is lit if anything sees it.
 */
function applyDetectionHighlights(): void {

    const litBy = new Map<string, Cesium.Color>();

    for (const radar of radars) {
        for (const detection of radar.detections) {

            // Inside the beam's limits but behind a ridge - the beam is cut
            // short before it gets there, so this is not a detection.
            if (detection.terrainShadowed) {
                continue;
            }

            const color = ZONE_COLORS.get(detection.zoneName);

            if (color && !litBy.has(detection.targetId)) {
                litBy.set(detection.targetId, color);
            }
        }
    }

    for (const obstacle of glbManager.list()) {

        const color = litBy.get(obstacle.id);

        if (color) {
            obstacle.model.silhouetteColor = color;
            obstacle.model.silhouetteSize = 3;
        } else {
            obstacle.model.silhouetteSize = 0;
        }
    }

    viewer.scene.requestRender();
}

// =============================================================================
// Coverage build
// =============================================================================

function buildOptions(radar: RadarState) {

    const zoneOverrides: Record<string, RadarZoneOverride> = {};

    for (const [name, zone] of radar.zones) {
        zoneOverrides[name] = {
            visible: zone.visible,
            range: zone.range,
            minElevationDeg: 0,
            maxElevationDeg: zone.maxElevationDeg,
            showOverlay: zone.selected
        };
    }

    return {
        entityId: radar.id,
        longitude: radar.longitude,
        latitude: radar.latitude,
        mastHeight: radar.mastHeight,
        headingDeg: radar.headingDeg,
        sectorSweepDeg: radar.sectorSweepDeg,
        drawRays: radar.drawRays,
        markBlockedRays: radar.markBlockedRays,
        beamOpacity: radar.beamOpacity,
        beamStyle: radar.showLattice ? ("lattice" as const) : ("solid" as const),
        useObjectPicking: true,
        // The lab keeps its own persistent marker; see RadarState.marker.
        showMarker: false,
        targets: detectionTargets(),
        onDetections: (detections: Detection[]) => {
            radar.detections = detections;
        },
        zoneOverrides
    };
}

/** Every control that changes a radar routes through here, so nothing is lost. */
function changeRadar(radar: RadarState): void {
    saveRadars();
    void rebuildRadar(radar);
}


async function rebuildRadar(radar: RadarState): Promise<void> {

    if (radar.buildInFlight) {
        radar.rebuildQueued = true;
        return;
    }

    radar.buildInFlight = true;

    const startedAt = performance.now();

    try {

        // Clear first, so a slow rebuild reads as "working" rather than as the
        // control having been ignored.
        //
        // This sits INSIDE the try because disposing a primitive Cesium has
        // already destroyed throws, and thrown from out there it skipped the
        // finally - leaving buildInFlight set forever, so every later rebuild
        // parked itself as pending and the beams never came back until the page
        // was reloaded.
        for (const handle of radar.handles) {
            handle.dispose();
        }
        radar.handles = [];

        radar.handles = await CesiumRadarCoverage.create3DRadarZones(
            viewer,
            terrainProvider,
            buildOptions(radar)
        );
    } catch (err) {
        console.error(`Radar build failed for ${radar.name}:`, err);
    } finally {
        radar.lastBuildMs = Math.round(performance.now() - startedAt);
        radar.buildInFlight = false;

        applyDetectionHighlights();
        renderDetections();
        renderRadarList();
        renderDiagnostics();
        viewer.scene.requestRender();

        if (radar.rebuildQueued) {
            radar.rebuildQueued = false;
            void rebuildRadar(radar);
        }
    }
}

function rebuildAll(): void {
    for (const radar of radars) {
        void rebuildRadar(radar);
    }
}

// =============================================================================
// Radar add / remove / select
// =============================================================================

function viewCentre(): { longitude: number; latitude: number } {

    const scene = viewer.scene;

    const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(
        scene.canvas.clientWidth / 2,
        scene.canvas.clientHeight / 2
    ));

    const position = ray ? scene.globe.pick(ray, scene) : undefined;

    if (!position) {
        return { ...START };
    }

    const carto = Cesium.Cartographic.fromCartesian(position);

    return {
        longitude: Cesium.Math.toDegrees(carto.longitude),
        latitude: Cesium.Math.toDegrees(carto.latitude)
    };
}

function createMarker(id: string, name: string, longitude: number, latitude: number): Cesium.Entity {

    const marker = viewer.entities.add({
        // Clamped to the ground so it needs no terrain sample of its own and
        // follows the terrain when the radar is moved.
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
        point: {
            pixelSize: 18,
            color: Cesium.Color.BLACK,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            // Always visible, even when it is inside a beam or behind a ridge.
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
            text: name,
            font: "11px system-ui, sans-serif",
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -22),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
    });

    // Same tag the coverage pieces carry, so clicking the dot selects the radar.
    (marker as any).radarParentId = id;

    return marker;
}

/** Repaints every marker so the selected radar reads as selected. */
function refreshMarkers(): void {

    for (const radar of radars) {
        const point = radar.marker.point;

        if (!point) {
            continue;
        }

        const selected = radar.id === selectedRadarId;

        point.outlineColor = new Cesium.ConstantProperty(
            selected ? Cesium.Color.fromCssColorString("#3b82f6") : Cesium.Color.WHITE
        );
        point.pixelSize = new Cesium.ConstantProperty(selected ? 20 : 15);
    }

    viewer.scene.requestRender();
}

function moveRadar(radar: RadarState, longitude: number, latitude: number): void {

    radar.longitude = longitude;
    radar.latitude = latitude;

    radar.marker.position = new Cesium.ConstantPositionProperty(
        Cesium.Cartesian3.fromDegrees(longitude, latitude)
    );

    changeRadar(radar);
}

function addRadar(
    at?: { longitude: number; latitude: number },
    saved?: StoredRadar
): RadarState {

    const position = saved ?? at ?? viewCentre();
    const id = `radar-${Date.now()}-${nextRadarNumber}`;
    const name = saved?.name ?? `Radar ${nextRadarNumber}`;
    nextRadarNumber++;

    const zones = defaultZones();

    // Merge saved zone settings onto the defaults rather than replacing them,
    // so a save written before a zone existed still loads.
    if (saved?.zones) {
        for (const [zoneName, zone] of Object.entries(saved.zones)) {
            const current = zones.get(zoneName);
            if (current) {
                zones.set(zoneName, { ...current, ...zone });
            }
        }
    }

    const radar: RadarState = {
        id,
        name,
        longitude: position.longitude,
        latitude: position.latitude,
        headingDeg: saved?.headingDeg ?? 0,
        sectorSweepDeg: saved?.sectorSweepDeg ?? 360,
        mastHeight: saved?.mastHeight ?? 0,
        showLattice: saved?.showLattice ?? false,
        drawRays: saved?.drawRays ?? false,
        markBlockedRays: saved?.markBlockedRays ?? true,
        beamOpacity: saved?.beamOpacity ?? 0.12,
        zones,
        marker: createMarker(id, name, position.longitude, position.latitude),
        handles: [],
        detections: [],
        buildInFlight: false,
        rebuildQueued: false,
        lastBuildMs: 0
    };

    radars.push(radar);
    selectRadar(radar.id);
    saveRadars();

    void rebuildRadar(radar);

    return radar;
}

function removeRadar(id: string): void {

    const index = radars.findIndex(r => r.id === id);

    if (index === -1) {
        return;
    }

    const [radar] = radars.splice(index, 1);

    for (const handle of radar.handles) {
        handle.dispose();
    }

    viewer.entities.remove(radar.marker);

    saveRadars();

    if (selectedRadarId === id) {
        selectRadar(radars[0]?.id ?? null);
    } else {
        renderAll();
    }

    viewer.scene.requestRender();
}

function selectRadar(id: string | null): void {
    selectedRadarId = id;
    refreshMarkers();
    renderAll();
}

// -----------------------------------------------------------------------------
// Placement mode: "+ Radar" arms it, the next click on the map drops the radar
// there. Placing at the centre of the view meant the camera had to be moved to
// aim, which is the wrong way round.
// -----------------------------------------------------------------------------

let placingRadar = false;

function setPlacingRadar(active: boolean): void {

    placingRadar = active;

    const button = $("add-radar");
    button.textContent = active ? "Click the map…" : "+ Radar";
    button.classList.toggle("pill--armed", active);

    viewer.scene.canvas.style.cursor = active ? "crosshair" : "";

    $("radar-count").textContent = active
        ? "click anywhere on the terrain to place it (Esc to cancel)"
        : radarCountLabel();
}

function radarCountLabel(): string {
    return radars.length === 0
        ? "none — press + Radar"
        : `${radars.length} placed · click one on the map to select`;
}

// =============================================================================
// Panel rendering
// =============================================================================

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const normalizeDeg = (value: number) => ((value % 360) + 360) % 360;

const compassLabel = (headingDeg: number) =>
    COMPASS[Math.round(normalizeDeg(headingDeg) / 22.5) % 16];

function renderAll(): void {
    renderRadarList();
    renderRadarTools();
    renderZones();
    renderDetections();
    renderDiagnostics();
}

function renderRadarList(): void {

    if (!placingRadar) {
        $("radar-count").textContent = radarCountLabel();
    }

    const list = $("radar-list");
    list.innerHTML = "";

    for (const radar of radars) {

        const row = document.createElement("button");
        row.type = "button";
        row.className = "radar-row" + (radar.id === selectedRadarId ? " radar-row--on" : "");
        row.innerHTML = `
            <span class="radar-row__name">${radar.name}</span>
            <span class="radar-row__meta">
                ${radar.sectorSweepDeg >= 360 ? "360°" : `${radar.sectorSweepDeg}° @ ${Math.round(radar.headingDeg)}°`}
                · ${radar.detections.filter(d => !d.terrainShadowed).length} det
            </span>
        `;
        row.addEventListener("click", () => selectRadar(radar.id));

        list.appendChild(row);
    }
}

function renderRadarTools(): void {

    const radar = selectedRadar();
    const tools = $("radar-tools");

    if (!radar) {
        tools.hidden = true;
        return;
    }

    tools.hidden = false;

    $("selected-name").textContent = radar.name;
    $<HTMLInputElement>("heading-range").value = String(Math.round(radar.headingDeg));
    $<HTMLInputElement>("heading-number").value = String(Math.round(radar.headingDeg));
    $("heading-compass").textContent = compassLabel(radar.headingDeg);
    $<HTMLInputElement>("sweep").value = String(radar.sectorSweepDeg);
    $<HTMLInputElement>("mast").value = String(radar.mastHeight);
    $<HTMLInputElement>("lattice").checked = radar.showLattice;
    $<HTMLInputElement>("rays").checked = radar.drawRays;
    $<HTMLInputElement>("marks").checked = radar.markBlockedRays;
    $<HTMLInputElement>("opacity").value = String(radar.beamOpacity);
    $("opacity-value").textContent = radar.beamOpacity.toFixed(2);
}

function renderZones(): void {

    const radar = selectedRadar();
    const container = $("zones");

    container.innerHTML = "";

    if (!radar) {
        return;
    }

    for (const config of CesiumRadarCoverage.DEFAULT_3D_ZONES) {

        const zone = radar.zones.get(config.name)!;

        const card = document.createElement("div");
        card.className = "card" + (zone.selected ? " card--picked" : "");

        card.innerHTML = `
            <div class="card__header">
                <input type="checkbox" data-role="visible" title="Show this beam"
                    ${zone.visible ? "checked" : ""}>
                <button type="button" class="zone-pick" data-role="select"
                    title="Select this beam for the overlays">
                    <span class="dot" style="background:${config.cssColor}"></span>
                    <span class="card__name">${config.name}</span>
                </button>
            </div>
            <div class="card__fields">
                <label class="field">
                    <span>RANGE (M)</span>
                    <input type="number" min="100" step="500" data-role="range" value="${zone.range}">
                </label>
                <label class="field">
                    <span>BEAM WIDTH (°)</span>
                    <input type="number" min="0" max="90" step="0.5" data-role="elevation" value="${zone.maxElevationDeg}">
                </label>
            </div>
            <div class="card__hint">Beam from 0° to ${zone.maxElevationDeg}° above horizontal</div>
        `;

        card.querySelector<HTMLInputElement>('[data-role="visible"]')!
            .addEventListener("change", event => {
                zone.visible = (event.target as HTMLInputElement).checked;
                changeRadar(radar);
            });

        card.querySelector<HTMLButtonElement>('[data-role="select"]')!
            .addEventListener("click", () => {
                zone.selected = !zone.selected;
                renderZones();
                changeRadar(radar);
            });

        card.querySelector<HTMLInputElement>('[data-role="range"]')!
            .addEventListener("change", event => {
                zone.range = Math.max(100, +(event.target as HTMLInputElement).value);
                changeRadar(radar);
            });

        card.querySelector<HTMLInputElement>('[data-role="elevation"]')!
            .addEventListener("change", event => {
                zone.maxElevationDeg = +(event.target as HTMLInputElement).value;
                renderZones();
                changeRadar(radar);
            });

        container.appendChild(card);
    }
}

function renderObstacles(): void {

    // A model that has just been added is not lit until the next build says so,
    // and one that was removed takes its highlight with it.
    applyDetectionHighlights();

    const container = $("obstacles");
    const obstacles = glbManager.list();

    container.innerHTML = "";

    if (obstacles.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent =
            "Add a .glb to drop it at the centre of the view, then drag it across " +
            "the terrain. Anything standing in a beam is detected, however small. " +
            "Obstacles are kept when you reload.";
        container.appendChild(empty);
        return;
    }

    for (const obstacle of obstacles) {
        container.appendChild(obstacleCard(obstacle));
    }
}

function obstacleCard(obstacle: PlacedGlb): HTMLElement {

    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
        <div class="card__header">
            <span class="card__name" title="${obstacle.name}">${obstacle.name}</span>
            <span class="card__actions">
                <button type="button" data-role="fly" title="Fly to">🎯</button>
                <button type="button" data-role="remove" title="Remove">✕</button>
            </span>
        </div>
        <label class="field field--stacked">
            <span>SIZE (x${obstacle.scale})</span>
            <input type="range" min="0.1" max="200" step="0.1" data-role="scale" value="${obstacle.scale}">
        </label>
        <label class="field field--stacked">
            <span>HEIGHT ABOVE GROUND (M)</span>
            <input type="number" min="0" step="10" data-role="height" value="${obstacle.heightAboveGround}">
        </label>
        <div class="card__hint">
            ${obstacle.latitude.toFixed(5)}, ${obstacle.longitude.toFixed(5)}
        </div>
    `;

    card.querySelector<HTMLButtonElement>('[data-role="fly"]')!
        .addEventListener("click", () => glbManager.flyTo(obstacle.id));

    card.querySelector<HTMLButtonElement>('[data-role="remove"]')!
        .addEventListener("click", () => glbManager.remove(obstacle.id));

    card.querySelector<HTMLInputElement>('[data-role="scale"]')!
        .addEventListener("input", event => {
            glbManager.setScale(obstacle.id, +(event.target as HTMLInputElement).value);
        });

    card.querySelector<HTMLInputElement>('[data-role="height"]')!
        .addEventListener("change", event => {
            glbManager.setHeight(obstacle.id, +(event.target as HTMLInputElement).value);
        });

    return card;
}

function renderDetections(): void {

    const radar = selectedRadar();
    const container = $("detections");

    container.innerHTML = "";

    if (!radar) {
        container.innerHTML = `<div class="hint">No radar selected.</div>`;
        return;
    }

    if (radar.detections.length === 0) {
        container.innerHTML =
            `<div class="hint">Nothing in ${radar.name}'s beams. Add a GLB and ` +
            `drag it into one.</div>`;
        return;
    }

    const colorOf = (zoneName: string) =>
        CesiumRadarCoverage.DEFAULT_3D_ZONES.find(z => z.name === zoneName)?.cssColor ?? "#9ca3af";

    for (const detection of radar.detections) {

        const row = document.createElement("div");
        row.className = "detection" + (detection.terrainShadowed ? " detection--shadowed" : "");

        row.innerHTML = `
            <div class="detection__head">
                <span class="dot" style="background:${colorOf(detection.zoneName)}"></span>
                <span class="detection__name">${detection.targetName}</span>
                <span class="detection__zone">${detection.zoneName}</span>
            </div>
            <div class="detection__stats">
                <span>range <b>${Math.round(detection.slantRangeM).toLocaleString()} m</b></span>
                <span>bearing <b>${Math.round(detection.bearingDeg).toString().padStart(3, "0")}°</b></span>
                <span>elev <b>${detection.elevationDeg >= 0 ? "+" : ""}${detection.elevationDeg.toFixed(1)}°</b></span>
            </div>
            ${detection.terrainShadowed
                ? `<div class="detection__flag">terrain cuts the beam before it — no detection</div>`
                : ""}
        `;

        container.appendChild(row);
    }
}

/**
 * Object blocking fails silently by nature: a ray that was never tested looks
 * exactly like a ray that was tested and missed. This puts every stage on
 * screen so "the GLB is not blocking" becomes a specific answer.
 *
 * Note this describes how the GLB cuts the drawn BEAM, which is sampled. Whether
 * the GLB is DETECTED is a separate, analytic question - see the panel above.
 */
/**
 * How the beam was sampled, and how obstacles cut it.
 *
 * Blocking fails silently by nature: a ray that was never tested looks exactly
 * like a ray that was tested and missed. Every stage that can drop a ray is
 * counted rather than guessed at.
 *
 * "Blocking method" is the one to watch. "own BVH" means rays are intersected
 * against a snapshot of the obstacle's triangles, with no dependence on the
 * camera or on a frame having been rendered. "Cesium pickModel" means the
 * geometry could not be read and it fell back to Cesium's per-ray walk, which is
 * far slower and only correct once a frame has refreshed the model's transform.
 *
 * Note this describes the drawn BEAM, which is sampled. Whether an object is
 * DETECTED is a separate, analytic question - see the panel above.
 */
function renderDiagnostics(): void {

    const d = CesiumObjectDetector.latestDiagnostics;
    const b = CesiumRadarCoverage.lastBuildStats;
    const radar = selectedRadar();

    const methodLabel = {
        bvh: "own BVH (no render loop)",
        pickModel: "Cesium pickModel (fallback)",
        none: "nothing to block"
    }[d.method];

    const rows: [string, string, boolean?][] = [
        ["Build time", radar ? `${radar.lastBuildMs} ms` : "\u2014"],
        ["Beam rays", b.rays.toLocaleString()],
        ["Azimuths x rings", `${b.columns} x ${b.rings}`],
        ["Terrain profiles", String(b.profileAzimuths)],
        ["Rays stopped: object", b.stoppedByObject.toLocaleString(),
            d.candidates > 0 && b.stoppedByObject === 0],
        ["Rays stopped: terrain", b.stoppedByTerrain.toLocaleString()],
        ["Rays at full range", b.stoppedByRange.toLocaleString()],
        ["Blocking method", methodLabel, d.method === "pickModel"],
        ["Models found", String(d.modelsFound), d.modelsFound === 0],
        ["Models not ready", String(d.modelsNotReady), d.modelsNotReady > 0],
        ["Obstacle triangles", d.triangles.toLocaleString(), d.candidates > 0 && d.triangles === 0],
        ["Rays tested", String(d.raysTested), d.raysTested === 0 && d.candidates > 0],
        ["Rays missed sphere", String(d.raysRejectedBySphere)],
        ["Rays missed geometry", String(d.raysMissedGeometry)],
        ["Rays BLOCKED", String(d.raysBlocked), d.raysBlocked === 0 && d.candidates > 0]
    ];

    if (d.lastError) {
        rows.push(["Error", d.lastError, true]);
    }

    $("diagnostics").innerHTML = rows.map(([label, value, bad]) => `
        <div class="diag-row${bad ? " diag-row--bad" : ""}">
            <span>${label}</span><b>${value}</b>
        </div>
    `).join("");
}

// =============================================================================
// Control wiring
// =============================================================================

function withSelected(run: (radar: RadarState) => void): void {
    const radar = selectedRadar();
    if (radar) {
        run(radar);
    }
}

$("add-radar").addEventListener("click", () => setPlacingRadar(!placingRadar));

window.addEventListener("keydown", event => {
    if (event.key === "Escape" && placingRadar) {
        setPlacingRadar(false);
    }
});

$("delete-radar").addEventListener("click", () => {
    withSelected(radar => removeRadar(radar.id));
});

function setHeading(value: number): void {
    withSelected(radar => {
        radar.headingDeg = normalizeDeg(Math.round(value));
        renderRadarTools();
        renderRadarList();
        changeRadar(radar);
    });
}

$<HTMLInputElement>("heading-range").addEventListener("input", event => {
    setHeading(+(event.target as HTMLInputElement).value);
});

$<HTMLInputElement>("heading-number").addEventListener("change", event => {
    setHeading(+(event.target as HTMLInputElement).value);
});

$<HTMLInputElement>("sweep").addEventListener("change", event => {
    withSelected(radar => {
        radar.sectorSweepDeg = Cesium.Math.clamp(+(event.target as HTMLInputElement).value, 1, 360);
        renderRadarList();
        changeRadar(radar);
    });
});

$<HTMLInputElement>("mast").addEventListener("change", event => {
    withSelected(radar => {
        radar.mastHeight = Math.max(0, +(event.target as HTMLInputElement).value);
        changeRadar(radar);
    });
});

$<HTMLInputElement>("lattice").addEventListener("change", event => {
    withSelected(radar => {
        radar.showLattice = (event.target as HTMLInputElement).checked;
        changeRadar(radar);
    });
});

$<HTMLInputElement>("rays").addEventListener("change", event => {
    withSelected(radar => {
        radar.drawRays = (event.target as HTMLInputElement).checked;
        changeRadar(radar);
    });
});

$<HTMLInputElement>("opacity").addEventListener("input", event => {
    withSelected(radar => {
        radar.beamOpacity = +(event.target as HTMLInputElement).value;
        $("opacity-value").textContent = radar.beamOpacity.toFixed(2);
        changeRadar(radar);
    });
});

$<HTMLInputElement>("marks").addEventListener("change", event => {
    withSelected(radar => {
        radar.markBlockedRays = (event.target as HTMLInputElement).checked;
        changeRadar(radar);
    });
});

$<HTMLInputElement>("glb-file").addEventListener("change", async event => {

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
        return;
    }

    try {
        await glbManager.addFromFile(file, 0, 1);
    } catch (err) {
        console.error("Failed to load GLB:", err);
    } finally {
        input.value = "";
        renderObstacles();
    }
});

// =============================================================================
// Map interaction
// =============================================================================

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
const cameraController = viewer.scene.screenSpaceCameraController;

let draggingObstacleId: string | null = null;
let draggedObstacleMoved = false;

/**
 * drillPick rather than pick: an obstacle standing inside a beam has that
 * translucent volume in front of it, and a plain pick would return the beam -
 * making the obstacle impossible to grab.
 */
function pickObstacleAt(position: Cesium.Cartesian2): PlacedGlb | undefined {

    for (const pick of viewer.scene.drillPick(position, 8)) {
        const obstacle = glbManager.findByModel(pick?.primitive);

        if (obstacle) {
            return obstacle;
        }
    }

    return undefined;
}

/**
 * Every pickable piece of a radar - its marker, its beams, its footprint - is
 * tagged with the radar's id, so clicking any part of it selects that radar.
 */
function pickRadarAt(position: Cesium.Cartesian2): string | null {

    for (const pick of viewer.scene.drillPick(position, 8)) {

        const id = (pick?.id as { radarParentId?: string } | undefined)?.radarParentId;

        if (id && radars.some(radar => radar.id === id)) {
            return id;
        }
    }

    return null;
}

function pickGround(position: Cesium.Cartesian2): Cesium.Cartographic | null {

    const ray = viewer.camera.getPickRay(position);

    if (!ray) {
        return null;
    }

    // globe.pick, not scene.pickPosition: the latter lands on whatever is being
    // dragged instead of on the ground under it.
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);

    return cartesian ? Cesium.Cartographic.fromCartesian(cartesian) : null;
}

handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {

    const obstacle = pickObstacleAt(event.position);

    if (!obstacle) {
        return;
    }

    draggingObstacleId = obstacle.id;
    draggedObstacleMoved = false;

    cameraController.enableRotate = false;
    cameraController.enableTranslate = false;
    cameraController.enableTilt = false;
    cameraController.enableLook = false;

}, Cesium.ScreenSpaceEventType.LEFT_DOWN);

handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {

    if (!draggingObstacleId) {
        return;
    }

    const ground = pickGround(event.endPosition);

    if (!ground) {
        return;
    }

    draggedObstacleMoved = true;

    // Coverage is not rebuilt here - it would rescan the terrain on every
    // mouse-move and the model would crawl behind the cursor.
    glbManager.setPosition(
        draggingObstacleId,
        Cesium.Math.toDegrees(ground.longitude),
        Cesium.Math.toDegrees(ground.latitude),
        false
    );

}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

handler.setInputAction(() => {

    if (!draggingObstacleId) {
        return;
    }

    const id = draggingObstacleId;
    draggingObstacleId = null;

    cameraController.enableRotate = true;
    cameraController.enableTranslate = true;
    cameraController.enableTilt = true;
    cameraController.enableLook = true;

    if (!draggedObstacleMoved) {
        return;
    }

    draggedObstacleMoved = false;

    const placed = glbManager.find(id);

    if (placed) {
        glbManager.setPosition(id, placed.longitude, placed.latitude, true);
    }

    renderObstacles();

}, Cesium.ScreenSpaceEventType.LEFT_UP);

handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {

    // A click that landed on an obstacle was a grab, not a map click -
    // LEFT_CLICK still fires on mouse-up after a short drag.
    if (pickObstacleAt(event.position)) {
        return;
    }

    const ground = pickGround(event.position);

    // Armed by "+ Radar": this click chooses where the new radar stands.
    if (placingRadar) {

        if (!ground) {
            return;
        }

        setPlacingRadar(false);

        addRadar({
            longitude: Cesium.Math.toDegrees(ground.longitude),
            latitude: Cesium.Math.toDegrees(ground.latitude)
        });

        return;
    }

    // Clicking any part of a radar selects it, and opens its tools alone.
    const radarId = pickRadarAt(event.position);

    if (radarId) {
        selectRadar(radarId);
        return;
    }

    // Otherwise the click moves the selected radar to that spot.
    const radar = selectedRadar();

    if (!radar || !ground) {
        return;
    }

    moveRadar(
        radar,
        Cesium.Math.toDegrees(ground.longitude),
        Cesium.Math.toDegrees(ground.latitude)
    );

}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// =============================================================================
// Go
// =============================================================================

renderAll();
renderObstacles();

await glbManager.restoreSaved();
renderObstacles();

// Radars survive a reload, the same as obstacles. Only an empty store starts
// one off at the default position.
const savedRadars = loadStoredRadars();

if (savedRadars.length === 0) {
    addRadar(START);
} else {
    for (const saved of savedRadars) {
        addRadar(undefined, saved);
    }
    selectRadar(radars[0]?.id ?? null);
}
