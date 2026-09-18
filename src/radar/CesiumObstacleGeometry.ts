import * as Cesium from "cesium";

/**
 * A snapshot of an obstacle's triangles, plus a BVH over them, so radar rays can
 * be intersected against real geometry without Cesium in the loop.
 *
 * Two problems with asking Cesium's pickModel to do this per ray:
 *
 * 1. It reads the model's transform from sceneGraph.computedModelMatrix, which
 *    is only refreshed inside model.update() during a rendered frame. With
 *    requestRenderMode on, a build that runs before any frame has been drawn
 *    intersects the model's PREVIOUS transform - which is why moving the camera
 *    (and so forcing a frame) appeared to decide whether blocking worked.
 *
 * 2. It walks every triangle of the model on every single call. One ray against
 *    a 50k-triangle model is 50k intersection tests, so the cost of sampling the
 *    beam densely enough to resolve an object grew as rays x triangles.
 *
 * Extracting once into a BVH fixes both: the geometry is captured at a known
 * moment rather than whenever a frame happened, and a ray costs O(log n).
 */

type ModelReaderLike = {
    forEachPrimitive(
        model: Cesium.Model,
        options: unknown,
        callback: (
            runtimePrimitive: unknown,
            primitive: { indices?: unknown },
            instances: { transform: Cesium.Matrix4 }[],
            computedModelMatrix: Cesium.Matrix4
        ) => void
    ): void;
    readAttributeAsTypedArray(attribute: unknown): ArrayLike<number> | undefined;
    readIndicesAsTypedArray(indices: unknown): ArrayLike<number> | undefined;
};

type ModelUtilityLike = {
    getAttributeBySemantic(primitive: unknown, semantic: string): unknown;
};

// Both are real exports of the cesium package that its .d.ts leaves out, the
// same as pickModel. Absence is handled rather than assumed.
const ModelReader = (Cesium as unknown as { ModelReader?: ModelReaderLike }).ModelReader;
const VertexAttributeSemantic =
    (Cesium as unknown as { VertexAttributeSemantic?: Record<string, string> }).VertexAttributeSemantic;

/** Leaf size. Small enough to prune well, large enough that the tree stays shallow. */
const BVH_LEAF_TRIANGLES = 8;

export class ObstacleGeometry {

    /**
     * Triangle vertices, 9 doubles each, stored RELATIVE to `origin`.
     *
     * World positions are ~6.4e6 metres from the earth's centre, so subtracting
     * two of them in the intersection test throws away most of the mantissa.
     * Rebasing onto the obstacle's own centre keeps the numbers small and the
     * intersections accurate to well under a millimetre.
     */
    private readonly triangles: Float64Array;
    private readonly triangleCount: number;
    private readonly origin: Cesium.Cartesian3;

    // Flat BVH. Interior nodes point at their left child (right is left + 1);
    // leaves carry a range into `order`.
    private readonly order: Uint32Array;
    private nodeMin!: Float64Array;
    private nodeMax!: Float64Array;
    private nodeLeft!: Int32Array;
    /**
     * Held explicitly rather than assumed to be left + 1.
     *
     * The left subtree is built in full before the right one starts, so the
     * right child lands after every node the left subtree allocated - not next
     * to its sibling. Traversing to left + 1 walks into the left child's OWN
     * child, skipping most of the tree, and rays pass through geometry they
     * should have hit.
     */
    private nodeRight!: Int32Array;
    private nodeStart!: Uint32Array;
    private nodeCount!: Uint32Array;
    private nodeTotal = 0;

    private constructor(
        triangles: Float64Array,
        triangleCount: number,
        origin: Cesium.Cartesian3
    ) {
        this.triangles = triangles;
        this.triangleCount = triangleCount;
        this.origin = origin;
        this.order = new Uint32Array(triangleCount);

        for (let i = 0; i < triangleCount; i++) {
            this.order[i] = i;
        }

        this.buildTree();
    }

    /**
     * Builds directly from world-space triangle vertices, 9 doubles each.
     * Exists so the BVH can be checked against brute force without a WebGL
     * context - the traversal is easy to get subtly wrong and impossible to see
     * going wrong on screen, since a missed hit just looks like a ray that
     * passed by.
     */
    static fromTriangles(positions: Float64Array): ObstacleGeometry | null {

        const triangleCount = Math.floor(positions.length / 9);

        if (triangleCount === 0) {
            return null;
        }

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < positions.length; i += 3) {
            minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
            minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
            minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
        }

        const origin = new Cesium.Cartesian3(
            (minX + maxX) / 2,
            (minY + maxY) / 2,
            (minZ + maxZ) / 2
        );

        const rebased = new Float64Array(triangleCount * 9);

        for (let i = 0; i < rebased.length; i += 3) {
            rebased[i] = positions[i] - origin.x;
            rebased[i + 1] = positions[i + 1] - origin.y;
            rebased[i + 2] = positions[i + 2] - origin.z;
        }

        return new ObstacleGeometry(rebased, triangleCount, origin);
    }

    static get isSupported(): boolean {
        return !!ModelReader && !!VertexAttributeSemantic;
    }

    get count(): number {
        return this.triangleCount;
    }

    /**
     * Captures a model's triangles in world space.
     *
     * The caller is responsible for making sure a frame has been rendered since
     * the model last moved - see CesiumObjectDetector.prepare. Everything after
     * this point is independent of Cesium's render loop.
     */
    static fromModel(model: Cesium.Model): ObstacleGeometry | null {

        if (!ModelReader || !VertexAttributeSemantic) {
            return null;
        }

        const collected: number[] = [];

        ModelReader.forEachPrimitive(
            model,
            {},
            (_runtimePrimitive, primitive, instances) => {

                if (!primitive.indices) {
                    // Point clouds and line geometry cannot block anything.
                    return;
                }

                const positionAttribute = (
                    Cesium as unknown as { ModelUtility?: ModelUtilityLike }
                ).ModelUtility?.getAttributeBySemantic(
                    primitive,
                    VertexAttributeSemantic["POSITION"] ?? "POSITION"
                ) ?? ObstacleGeometry.findPositionAttribute(primitive);

                if (!positionAttribute) {
                    return;
                }

                const vertices = ModelReader.readAttributeAsTypedArray(positionAttribute);
                const indices = ModelReader.readIndicesAsTypedArray(primitive.indices);

                if (!vertices || !indices) {
                    return;
                }

                const local = new Cesium.Cartesian3();
                const world = new Cesium.Cartesian3();

                for (const instance of instances) {
                    for (let i = 0; i + 2 < indices.length; i += 3) {
                        for (let corner = 0; corner < 3; corner++) {

                            const v = indices[i + corner] * 3;

                            local.x = vertices[v];
                            local.y = vertices[v + 1];
                            local.z = vertices[v + 2];

                            Cesium.Matrix4.multiplyByPoint(instance.transform, local, world);

                            collected.push(world.x, world.y, world.z);
                        }
                    }
                }
            }
        );

        const triangleCount = Math.floor(collected.length / 9);

        if (triangleCount === 0) {
            return null;
        }

        // Rebase onto the centroid of the bounds, for precision.
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < collected.length; i += 3) {
            minX = Math.min(minX, collected[i]); maxX = Math.max(maxX, collected[i]);
            minY = Math.min(minY, collected[i + 1]); maxY = Math.max(maxY, collected[i + 1]);
            minZ = Math.min(minZ, collected[i + 2]); maxZ = Math.max(maxZ, collected[i + 2]);
        }

        const origin = new Cesium.Cartesian3(
            (minX + maxX) / 2,
            (minY + maxY) / 2,
            (minZ + maxZ) / 2
        );

        const triangles = new Float64Array(triangleCount * 9);

        for (let i = 0; i < triangles.length; i += 3) {
            triangles[i] = collected[i] - origin.x;
            triangles[i + 1] = collected[i + 1] - origin.y;
            triangles[i + 2] = collected[i + 2] - origin.z;
        }

        return new ObstacleGeometry(triangles, triangleCount, origin);
    }

    /** Fallback for builds where ModelUtility is not reachable by name. */
    private static findPositionAttribute(primitive: unknown): unknown {

        const attributes = (primitive as { attributes?: { semantic?: string }[] }).attributes;

        if (!attributes) {
            return undefined;
        }

        return attributes.find(attribute => attribute.semantic === "POSITION");
    }

    // -----------------------------------------------------------------------
    // BVH
    // -----------------------------------------------------------------------

    private buildTree(): void {

        // Median splitting gives every leaf at least half the leaf size, so
        // there are at most N/(L/2) leaves and under twice that many nodes.
        // buildNode also falls back to a leaf if it ever runs out.
        const maxNodes = Math.max(
            2,
            4 * Math.ceil(this.triangleCount / BVH_LEAF_TRIANGLES) + 16
        );

        this.nodeMin = new Float64Array(maxNodes * 3);
        this.nodeMax = new Float64Array(maxNodes * 3);
        this.nodeLeft = new Int32Array(maxNodes).fill(-1);
        this.nodeRight = new Int32Array(maxNodes).fill(-1);
        this.nodeStart = new Uint32Array(maxNodes);
        this.nodeCount = new Uint32Array(maxNodes);
        this.nodeTotal = 0;

        this.buildNode(0, this.triangleCount);
    }

    /** Builds the node covering order[start, start + count) and returns its index. */
    private buildNode(start: number, count: number): number {

        const node = this.nodeTotal++;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = start; i < start + count; i++) {
            const base = this.order[i] * 9;

            for (let corner = 0; corner < 3; corner++) {
                const v = base + corner * 3;
                minX = Math.min(minX, this.triangles[v]); maxX = Math.max(maxX, this.triangles[v]);
                minY = Math.min(minY, this.triangles[v + 1]); maxY = Math.max(maxY, this.triangles[v + 1]);
                minZ = Math.min(minZ, this.triangles[v + 2]); maxZ = Math.max(maxZ, this.triangles[v + 2]);
            }
        }

        this.nodeMin[node * 3] = minX;
        this.nodeMin[node * 3 + 1] = minY;
        this.nodeMin[node * 3 + 2] = minZ;
        this.nodeMax[node * 3] = maxX;
        this.nodeMax[node * 3 + 1] = maxY;
        this.nodeMax[node * 3 + 2] = maxZ;

        // Out of node budget is not a correctness problem - an oversized leaf
        // is simply slower to test - so it degrades rather than corrupting.
        if (count <= BVH_LEAF_TRIANGLES || this.nodeTotal + 2 > this.nodeLeft.length) {
            this.nodeLeft[node] = -1;
            this.nodeRight[node] = -1;
            this.nodeStart[node] = start;
            this.nodeCount[node] = count;
            return node;
        }

        // Split at the median centroid along the widest axis.
        const spanX = maxX - minX;
        const spanY = maxY - minY;
        const spanZ = maxZ - minZ;

        const axis = spanX >= spanY && spanX >= spanZ ? 0 : (spanY >= spanZ ? 1 : 2);

        const slice = Array.from(this.order.subarray(start, start + count));

        slice.sort((a, b) => this.centroid(a, axis) - this.centroid(b, axis));
        this.order.set(slice, start);

        const half = count >> 1;

        const left = this.buildNode(start, half);
        const right = this.buildNode(start + half, count - half);

        this.nodeLeft[node] = left;
        this.nodeRight[node] = right;
        this.nodeCount[node] = 0;

        return node;
    }

    private centroid(triangle: number, axis: number): number {
        const base = triangle * 9 + axis;
        return (this.triangles[base] + this.triangles[base + 3] + this.triangles[base + 6]) / 3;
    }

    // -----------------------------------------------------------------------
    // Intersection
    // -----------------------------------------------------------------------

    private readonly stack = new Int32Array(64);

    /**
     * Distance from the ray origin to the nearest triangle, or Infinity.
     *
     * Deliberately double sided: an obstacle blocks a ray arriving from any
     * direction, so a ray reaching the concave side of a dish or the inside of
     * a single-sided wall must still stop.
     */
    intersect(ray: Cesium.Ray, maxDistance: number): number {

        if (this.nodeTotal === 0) {
            return Number.POSITIVE_INFINITY;
        }

        const ox = ray.origin.x - this.origin.x;
        const oy = ray.origin.y - this.origin.y;
        const oz = ray.origin.z - this.origin.z;

        const dx = ray.direction.x;
        const dy = ray.direction.y;
        const dz = ray.direction.z;

        const invX = 1 / dx;
        const invY = 1 / dy;
        const invZ = 1 / dz;

        let nearest = maxDistance;

        let top = 0;
        this.stack[top++] = 0;

        while (top > 0) {

            const node = this.stack[--top];
            const b = node * 3;

            // Slab test against the node's box.
            let tMin = 0;
            let tMax = nearest;

            let t1 = (this.nodeMin[b] - ox) * invX;
            let t2 = (this.nodeMax[b] - ox) * invX;
            tMin = Math.max(tMin, Math.min(t1, t2));
            tMax = Math.min(tMax, Math.max(t1, t2));

            t1 = (this.nodeMin[b + 1] - oy) * invY;
            t2 = (this.nodeMax[b + 1] - oy) * invY;
            tMin = Math.max(tMin, Math.min(t1, t2));
            tMax = Math.min(tMax, Math.max(t1, t2));

            t1 = (this.nodeMin[b + 2] - oz) * invZ;
            t2 = (this.nodeMax[b + 2] - oz) * invZ;
            tMin = Math.max(tMin, Math.min(t1, t2));
            tMax = Math.min(tMax, Math.max(t1, t2));

            if (tMax < tMin) {
                continue;
            }

            const left = this.nodeLeft[node];

            if (left >= 0) {
                if (top + 2 <= this.stack.length) {
                    this.stack[top++] = left;
                    this.stack[top++] = this.nodeRight[node];
                }
                continue;
            }

            const start = this.nodeStart[node];
            const end = start + this.nodeCount[node];

            for (let i = start; i < end; i++) {

                const hit = this.intersectTriangle(
                    this.order[i] * 9,
                    ox, oy, oz, dx, dy, dz
                );

                if (hit > 0 && hit < nearest) {
                    nearest = hit;
                }
            }
        }

        return nearest < maxDistance ? nearest : Number.POSITIVE_INFINITY;
    }

    /** Moeller-Trumbore, without the back-face rejection. */
    private intersectTriangle(
        base: number,
        ox: number, oy: number, oz: number,
        dx: number, dy: number, dz: number
    ): number {

        const t = this.triangles;

        const ax = t[base], ay = t[base + 1], az = t[base + 2];

        const e1x = t[base + 3] - ax, e1y = t[base + 4] - ay, e1z = t[base + 5] - az;
        const e2x = t[base + 6] - ax, e2y = t[base + 7] - ay, e2z = t[base + 8] - az;

        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;

        const det = e1x * px + e1y * py + e1z * pz;

        // Parallel to the triangle's plane.
        if (det > -1e-12 && det < 1e-12) {
            return -1;
        }

        const invDet = 1 / det;

        const tx = ox - ax, ty = oy - ay, tz = oz - az;

        const u = (tx * px + ty * py + tz * pz) * invDet;

        if (u < 0 || u > 1) {
            return -1;
        }

        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;

        const v = (dx * qx + dy * qy + dz * qz) * invDet;

        if (v < 0 || u + v > 1) {
            return -1;
        }

        return (e2x * qx + e2y * qy + e2z * qz) * invDet;
    }
}
