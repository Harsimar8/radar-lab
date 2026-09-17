import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// This project deliberately has no node_modules of its own. It borrows vite and
// cesium from the main app next door, so the lab can be started with one
// command and can never drift onto a different Cesium version than the code it
// is here to exercise.
const here = fileURLToPath(new URL(".", import.meta.url));
const mainApp = join(here, "..", "on2");
const cesiumPackage = join(mainApp, "node_modules", "cesium");
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
 * is not enough - those files have to be reachable over HTTP too. Normally a
 * plugin copies them into the project; here they are served straight out of the
 * neighbouring install so there is nothing to copy or keep in sync.
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
        }
    };
}

// A plain object rather than vite's defineConfig(): this project has no
// node_modules, so a bare `import ... from "vite"` here cannot resolve.
// defineConfig is only a typing helper and changes nothing at runtime.
export default {
    plugins: [serveCesiumAssets()],

    resolve: {
        alias: {
            cesium: cesiumPackage
        }
    },

    optimizeDeps: {
        // Without this, Cesium's several thousand source modules are transformed
        // one request at a time on first load. Pre-bundling makes the first
        // start take a few seconds instead of a minute.
        include: ["cesium"]
    },

    server: {
        port: 5180,
        open: true,
        fs: {
            // The lab imports the radar source straight out of the main app, so
            // vite has to be allowed to read outside its own root.
            allow: [here, mainApp]
        }
    }
};
