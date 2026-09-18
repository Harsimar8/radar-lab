import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Everything this project needs lives inside this folder: `npm install` then
// `npm run dev` is the whole setup. Cesium comes out of its own node_modules,
// so the version the lab runs is pinned by its own package.json.
const here = fileURLToPath(new URL(".", import.meta.url));
const cesiumPackage = join(here, "node_modules", "cesium");
const cesiumBuild = join(cesiumPackage, "Build", "Cesium");

const MIME_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".xml": "application/xml",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".ktx2": "image/ktx2",
    ".bin": "application/octet-stream",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf"
};

/**
 * Cesium loads its web workers, imagery decoders and widget CSS at runtime from
 * CESIUM_BASE_URL rather than through the module graph, so bundling the library
 * is not enough - those files have to be reachable over HTTP too. They are
 * served straight out of the installed package, so there is nothing to copy or
 * keep in sync during development.
 */
function serveCesiumAssets() {

    const middleware = (req, res, next) => {

        const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const target = normalize(join(cesiumBuild, requested));

        // Never serve outside the Cesium build directory.
        if (
            !target.startsWith(cesiumBuild) ||
            !existsSync(target) ||
            !statSync(target).isFile()
        ) {
            next();
            return;
        }

        res.setHeader(
            "Content-Type",
            MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream"
        );

        createReadStream(target).pipe(res);
    };

    return {
        name: "serve-cesium-assets",

        configureServer(server) {
            server.middlewares.use("/cesium", middleware);
        },

        // The production build leaves /cesium/* to be resolved at runtime, so
        // `preview` needs the same middleware or it serves a blank globe.
        configurePreviewServer(server) {
            server.middlewares.use("/cesium", middleware);
        },

        // `vite build` output is a plain folder someone may serve with any
        // static file server, which will not run the middleware above. Copy the
        // runtime assets in afterwards so dist/ stands on its own.
        closeBundle() {
            if (this.meta.watchMode) {
                return;
            }
            copyDirectory(cesiumBuild, join(here, "dist", "cesium"));
        }
    };
}

function copyDirectory(from, to) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = join(from, entry.name);
        const destination = join(to, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(source, destination);
        } else {
            copyFileSync(source, destination);
        }
    }
}

export default defineConfig({
    plugins: [serveCesiumAssets()],

    optimizeDeps: {
        // Without this, Cesium's several thousand source modules are transformed
        // one request at a time on first load. Pre-bundling makes the first
        // start take a few seconds instead of a minute.
        include: ["cesium"]
    },

    server: {
        port: 5180,
        open: true
    }
});
