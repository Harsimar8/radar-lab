import * as Cesium from "cesium";
import { ObstacleStore, StoredObstacle } from "./ObstacleStore";

export interface PlacedGlb {
    id: string;
    name: string;
    model: Cesium.Model;
    longitude: number;
    latitude: number;
    heightAboveGround: number;
    scale: number;
    /** Object URL to revoke on removal, for models loaded from a local file. */
    objectUrl?: string;
}

/**
 * Loads GLB models into the scene so they can be used as radar obstacles, and
 * keeps their placement editable (position, height above ground, scale).
 *
 * Radar coverage is rebuilt through the onChange callback rather than from here,
 * so this class stays unaware of radars. onListChanged is separate because the
 * obstacle list drives UI on every scale tick, while a radar rebuild is far too
 * expensive to run at that rate.
 */
export class CesiumGlbManager {

    private readonly placed: PlacedGlb[] = [];
    private readonly store = new ObstacleStore();
    private nextId = 1;

    /** Deferred metadata writes, so dragging a slider does not hammer IndexedDB. */
    private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly viewer: Cesium.Viewer,
        private readonly terrainProvider: Cesium.TerrainProvider,
        private readonly onChange: () => void,
        private readonly onListChanged: () => void = () => { }
    ) { }

    list(): PlacedGlb[] {
        return this.placed;
    }

    find(id: string): PlacedGlb | undefined {
        return this.placed.find(p => p.id === id);
    }

    /** The obstacle a picked scene primitive belongs to, if it is one. */
    findByModel(model: unknown): PlacedGlb | undefined {
        return this.placed.find(p => p.model === model);
    }

    // -------------------------------------------------------------------
    // Loading
    // -------------------------------------------------------------------

    /** Loads a GLB the user picked in the browser and drops it at the view centre. */
    async addFromFile(file: File, heightAboveGround: number, scale: number): Promise<void> {

        const bytes = await file.arrayBuffer();
        const centre = this.viewCentreCartographic();

        await this.place({
            id: `glb-${Date.now()}-${this.nextId++}`,
            name: file.name,
            bytes,
            longitude: Cesium.Math.toDegrees(centre.longitude),
            latitude: Cesium.Math.toDegrees(centre.latitude),
            heightAboveGround,
            scale
        }, true);
    }

    /**
     * Rebuilds every obstacle saved in a previous session. Called once on
     * startup: obstacles outlive a page reload and are only ever dropped when
     * the user removes one explicitly.
     */
    async restoreSaved(): Promise<void> {

        const records = await this.store.all();

        for (const record of records) {
            try {
                await this.place(record, false);
            } catch (err) {
                console.error(`Could not restore obstacle "${record.name}":`, err);
            }
        }

        if (records.length > 0) {
            this.onListChanged();
            this.rebuildAfterNextFrame();
        }
    }

    private async place(record: StoredObstacle, persist: boolean): Promise<void> {

        const objectUrl = URL.createObjectURL(
            new Blob([record.bytes], { type: "model/gltf-binary" })
        );

        try {
            const [ground] = await Cesium.sampleTerrainMostDetailed(
                this.terrainProvider,
                [Cesium.Cartographic.fromDegrees(record.longitude, record.latitude)]
            );

            const model = await Cesium.Model.fromGltfAsync({
                url: objectUrl,
                scale: record.scale,
                // Without this, reading the model's vertices back for triangle
                // picking fails on a WebGL1 context.
                enablePick: true,
                // An obstacle has to block a ray arriving from any direction.
                // Cesium's ray/triangle test culls back faces whenever this is
                // true (the default), so rays reaching the concave side of a
                // dish, or the inside of any single-sided surface, passed
                // straight through it.
                backFaceCulling: false,
                modelMatrix: CesiumGlbManager.modelMatrixFor(
                    record.longitude,
                    record.latitude,
                    (ground.height ?? 0) + record.heightAboveGround
                )
            });

            this.viewer.scene.primitives.add(model);

            this.placed.push({
                id: record.id,
                name: record.name,
                model,
                longitude: record.longitude,
                latitude: record.latitude,
                heightAboveGround: record.heightAboveGround,
                scale: record.scale,
                objectUrl
            });

            if (persist) {
                await this.store.put(record);
                this.onListChanged();
                // The model only gains its triangles once it has been through a
                // render pass, so coverage is rebuilt after it is truly pickable.
                this.rebuildWhenReady(model);
            }

        } catch (err) {
            URL.revokeObjectURL(objectUrl);
            throw err;
        }
    }

    // -------------------------------------------------------------------
    // Editing
    // -------------------------------------------------------------------

    setScale(id: string, scale: number): void {

        const placed = this.find(id);

        if (!placed) {
            return;
        }

        placed.scale = Math.max(0.01, scale);
        placed.model.scale = placed.scale;

        this.savePlacementSoon(placed);
        this.onListChanged();
        this.rebuildAfterNextFrame();
    }

    setHeight(id: string, heightAboveGround: number): void {

        const placed = this.find(id);

        if (!placed) {
            return;
        }

        placed.heightAboveGround = heightAboveGround;
        this.reposition(placed, true);
    }

    /**
     * Moves an obstacle to a new ground position.
     *
     * rebuildCoverage is false while a drag is in progress: re-running every
     * radar's terrain scan on each mouse-move would make the model crawl behind
     * the cursor, so the radars are left alone until the drop.
     */
    setPosition(
        id: string,
        longitude: number,
        latitude: number,
        rebuildCoverage: boolean
    ): void {

        const placed = this.find(id);

        if (!placed) {
            return;
        }

        placed.longitude = longitude;
        placed.latitude = latitude;

        this.reposition(placed, rebuildCoverage);
    }

    remove(id: string): void {

        const index = this.placed.findIndex(p => p.id === id);

        if (index === -1) {
            return;
        }

        const [placed] = this.placed.splice(index, 1);

        this.viewer.scene.primitives.remove(placed.model);

        if (placed.objectUrl) {
            URL.revokeObjectURL(placed.objectUrl);
        }

        const timer = this.saveTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.saveTimers.delete(id);
        }

        // Removal is the one thing that drops an obstacle for good - a reload
        // brings back everything the user did not explicitly delete.
        void this.store.remove(id);

        this.onListChanged();
        this.rebuildAfterNextFrame();
    }

    flyTo(id: string): void {

        const placed = this.find(id);

        if (!placed) {
            return;
        }

        this.viewer.camera.flyToBoundingSphere(placed.model.boundingSphere, {
            duration: 1.2
        });
    }

    // -------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------

    private async reposition(placed: PlacedGlb, rebuildCoverage: boolean): Promise<void> {

        const [ground] = await Cesium.sampleTerrainMostDetailed(
            this.terrainProvider,
            [Cesium.Cartographic.fromDegrees(placed.longitude, placed.latitude)]
        );

        placed.model.modelMatrix = CesiumGlbManager.modelMatrixFor(
            placed.longitude,
            placed.latitude,
            (ground.height ?? 0) + placed.heightAboveGround
        );

        this.savePlacementSoon(placed);
        this.onListChanged();

        if (rebuildCoverage) {
            this.rebuildAfterNextFrame();
        } else {
            this.viewer.scene.requestRender();
        }
    }

    private savePlacementSoon(placed: PlacedGlb): void {

        const existing = this.saveTimers.get(placed.id);

        if (existing) {
            clearTimeout(existing);
        }

        this.saveTimers.set(placed.id, setTimeout(() => {
            this.saveTimers.delete(placed.id);
            void this.store.updatePlacement({
                id: placed.id,
                name: placed.name,
                longitude: placed.longitude,
                latitude: placed.latitude,
                heightAboveGround: placed.heightAboveGround,
                scale: placed.scale
            });
        }, 400));
    }

    private static modelMatrixFor(
        longitude: number,
        latitude: number,
        height: number
    ): Cesium.Matrix4 {

        return Cesium.Transforms.eastNorthUpToFixedFrame(
            Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
        );
    }

    /** Ground point at the centre of the current view, falling back to the camera. */
    private viewCentreCartographic(): Cesium.Cartographic {

        const scene = this.viewer.scene;

        const centre = new Cesium.Cartesian2(
            scene.canvas.clientWidth / 2,
            scene.canvas.clientHeight / 2
        );

        const ray = this.viewer.camera.getPickRay(centre);
        const position = ray ? scene.globe.pick(ray, scene) : undefined;

        return position
            ? Cesium.Cartographic.fromCartesian(position)
            : this.viewer.camera.positionCartographic;
    }

    private rebuildWhenReady(model: Cesium.Model): void {

        if (model.ready) {
            this.rebuildAfterNextFrame();
            return;
        }

        const listener = () => {
            model.readyEvent.removeEventListener(listener);
            this.rebuildAfterNextFrame();
        };

        model.readyEvent.addEventListener(listener);
        this.viewer.scene.requestRender();
    }

    /**
     * A model's picking transform is recomputed during its render pass, so a
     * rebuild triggered before the next frame would still intersect the old
     * size/position.
     */
    private rebuildAfterNextFrame(): void {

        const scene = this.viewer.scene;

        const listener = () => {
            scene.postRender.removeEventListener(listener);
            this.onChange();
        };

        scene.postRender.addEventListener(listener);
        scene.requestRender();
    }
}
