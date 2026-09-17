# Radar Lab

A minimal sandbox for the radar coverage builder: a globe, terrain, radars and
GLB obstacles. Nothing else — no entity tree, no scenarios, no teams, no
property panel.

It exists to make the "GLB obstacles are not blocking rays" problem debuggable.
In the full app that failure is invisible: a ray that was never tested looks
exactly like a ray that was tested and missed. Here, the right-hand panel shows
every stage of object blocking, so the cause is a specific line rather than a
guess.

## Running it

```
cd radar-lab
npm run dev
```

There is **no `npm install`**. This project has no `node_modules` of its own —
`vite.config.mjs` borrows vite and Cesium from `../on2/node_modules`, and serves
Cesium's runtime assets straight out of that install. The first start takes a
few seconds while vite pre-bundles Cesium; after that it is instant.

It opens on <http://localhost:5180>.

## What it shares with the main app

The lab imports the **real** source out of `../on2`, not a copy:

- `CesiumRadarCoverage.ts` — the coverage builder
- `CesiumObjectDetector.ts` — ray/model blocking
- `CesiumGlbManager.ts` — obstacle loading, placement, persistence

So anything fixed here is fixed in `on2` too, and the lab can never drift onto a
different version of the code it is meant to exercise. Only the UI shell
(`index.html`, `src/main.ts`, `src/styles.css`) is local to this project.

Obstacles are stored in the same IndexedDB database as the main app, so a model
placed in either one shows up in the other.

## Controls

| | |
|---|---|
| `+ Radar` | Drops a radar at the centre of the view |
| Click a radar | Selects it — the tools panel then shows only that radar |
| `Delete` | Removes the selected radar |
| Click the terrain | Moves the **selected** radar there |
| Drag an obstacle | Moves it across the terrain |
| Heading | Which way the radar faces; the sector is centred on it |
| Sector Width | 360 = all round (heading then has no effect) |
| Show beam sampling grid | Draws the internal ring/rib lattice instead of a clean beam |
| Debug: draw individual rays | The old ray-fan view, for debugging only |

## Beams and detection

Each zone is drawn as **one solid beam**, not a bundle of rays: fill plus a
silhouette edge, with no internal lattice. Terrain cuts the beam where it gets
in the way, so a beam ends at the ridge that blocks it.

Detection is a **separate, analytic** calculation — it does not look for objects
in the beam's sampled ray grid. That grid's resolution is bounded by what can be
meshed and terrain-sampled in reasonable time, so anything smaller than the gap
between neighbouring rays would fall straight between them and never be seen; a
ray-grid search can only find objects roughly as large as its own sampling step.

Instead each target is solved for directly: exact bearing, elevation and slant
range from the antenna, tested against the beam's limits, then a terrain
line-of-sight check along the target's own azimuth. The cost is one terrain
profile per target, and the smallest detectable object is set by the target's
own size rather than by the beam's drawing resolution — so a bullet-sized object
standing in a beam is detected exactly as reliably as a hangar.

The **Detections** panel lists each object a beam holds, with which zone caught
it and its range, bearing and elevation. An object inside a beam's limits but
standing behind a ridge is listed greyed out, marked as terrain-shadowed.

## Reading the diagnostics panel

The rows narrow down where blocking stops, in order:

| Row | If it is wrong |
|---|---|
| `Cesium.pickModel` | `MISSING` means this Cesium build cannot do precise model picking at all — nothing else matters |
| `Models found` | `0` means the GLB is not in `scene.primitives` as a `Cesium.Model` |
| `Models not ready` | `> 0` means the coverage was built before the model finished loading |
| `Blocking candidates` | `0` with models found means every model was skipped as not-ready or hidden |
| `Rays tested` | `0` with candidates present means `useObjectPicking` is off |
| `Rays missed sphere` | All of them means no ray came near the model — wrong position, or a bounding sphere in the wrong coordinate space |
| `Rays missed geometry` | High means rays reached the model but hit no triangle — back-face culling, or the ray grid is too coarse for the object's size |
| `Rays BLOCKED` | What you want to be non-zero |
| `Pick error` | `pickModel` threw — the message says why (usually vertex data that cannot be read back) |

`Build time` is the whole coverage rebuild, for tracking the cost of the
sampling settings.
