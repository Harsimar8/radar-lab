/**
 * Persistence for placed GLB obstacles.
 *
 * The model's own bytes are kept alongside its placement, because a scenario is
 * only reproducible if the geometry comes back too: an obstacle is loaded from a
 * file the user picked off their machine, and the blob URL it was loaded through
 * dies with the page. Storing just the placement would restore a position with
 * nothing standing at it.
 *
 * That rules out localStorage - a single GLB routinely exceeds its ~5MB budget -
 * so this is IndexedDB, used directly rather than through a wrapper library.
 */

export interface StoredObstacle {
    id: string;
    name: string;
    bytes: ArrayBuffer;
    longitude: number;
    latitude: number;
    heightAboveGround: number;
    scale: number;
}

/** Everything but the bytes, for the cheap metadata-only updates. */
export type StoredObstaclePlacement = Omit<StoredObstacle, "bytes">;

const DATABASE_NAME = "air-defense";
const DATABASE_VERSION = 1;
const STORE_NAME = "obstacles";

export class ObstacleStore {

    private databasePromise: Promise<IDBDatabase> | null = null;

    private open(): Promise<IDBDatabase> {

        if (this.databasePromise) {
            return this.databasePromise;
        }

        this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {

            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

            request.onupgradeneeded = () => {
                const database = request.result;

                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: "id" });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        return this.databasePromise;
    }

    private async transaction<T>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore) => IDBRequest<T>
    ): Promise<T> {

        const database = await this.open();

        return new Promise<T>((resolve, reject) => {

            const transaction = database.transaction(STORE_NAME, mode);
            const request = run(transaction.objectStore(STORE_NAME));

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async all(): Promise<StoredObstacle[]> {
        try {
            const records = await this.transaction<StoredObstacle[]>(
                "readonly",
                store => store.getAll() as IDBRequest<StoredObstacle[]>
            );
            return records ?? [];
        } catch (err) {
            // A blocked or unavailable database (private browsing, quota, an
            // older schema) must not stop the map from loading.
            console.warn("Could not read stored obstacles:", err);
            return [];
        }
    }

    async put(record: StoredObstacle): Promise<void> {
        try {
            await this.transaction("readwrite", store => store.put(record));
        } catch (err) {
            console.warn("Could not persist obstacle:", err);
        }
    }

    /** Rewrites placement only, leaving the (much larger) bytes untouched. */
    async updatePlacement(placement: StoredObstaclePlacement): Promise<void> {
        try {
            const database = await this.open();

            await new Promise<void>((resolve, reject) => {

                const transaction = database.transaction(STORE_NAME, "readwrite");
                const store = transaction.objectStore(STORE_NAME);
                const read = store.get(placement.id) as IDBRequest<StoredObstacle | undefined>;

                read.onsuccess = () => {
                    const existing = read.result;

                    if (!existing) {
                        resolve();
                        return;
                    }

                    store.put({ ...existing, ...placement });
                };

                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        } catch (err) {
            console.warn("Could not persist obstacle placement:", err);
        }
    }

    async remove(id: string): Promise<void> {
        try {
            await this.transaction("readwrite", store => store.delete(id));
        } catch (err) {
            console.warn("Could not delete obstacle:", err);
        }
    }
}
