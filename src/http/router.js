const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const crypto = require("node:crypto");
const { serializeError } = require("../logger");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4"
};

const legacyStaticAliases = new Map([
  ["/styles.css", "shared/styles.css"],
  ["/lobby.js", "lobby/app.js"],
  ["/create.js", "create/app.js"],
  ["/scene.js", "scene/app.js"],
  ["/replay.js", "replay/app.js"],
  ["/admin.js", "admin/app.js"]
]);

function sendFile(response, filePath) {
  response.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(filePath).pipe(response);
}

function safeFile(baseDir, relativePath) {
  const resolvedBase = path.resolve(baseDir);
  const filePath = path.resolve(resolvedBase, relativePath);
  if (filePath !== resolvedBase && !filePath.startsWith(`${resolvedBase}${path.sep}`)) return null;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return null;
  return filePath;
}

function pageEntry(pathname) {
  if (pathname === "/") return "lobby/index.html";
  if (pathname === "/create" || pathname === "/create/") return "create/index.html";
  if (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin.html") return "admin/index.html";
  if (/^\/scene\/[a-z0-9-]+\/?$/.test(pathname)) return "scene/index.html";
  if (/^\/replay\/replay-[a-f0-9]{24}\/?$/.test(pathname)) return "replay/index.html";
  return "";
}

function publicAsset(pathname) {
  if (legacyStaticAliases.has(pathname)) return legacyStaticAliases.get(pathname);
  const match = pathname.match(/^\/(shared|lobby|create|scene|replay|admin)\/(.+)$/);
  if (!match) return "";
  return `${match[1]}/${match[2]}`;
}

function createRouter({
  host,
  publicDir,
  assetsDir,
  apiHandler,
  resolveReplayAsset,
  resolveSceneAsset,
  logger = console,
  onError = (error) => logger.error("HTTP 服务异常", { error: serializeError(error) })
}) {
  return async function router(request, response) {
    const startedAt = Date.now();
    const requestId = request.headers["x-request-id"] || crypto.randomUUID();
    request.requestId = String(requestId);
    response.setHeader("X-Request-Id", request.requestId);
    response.once("finish", () => {
      const pathname = request.url ? new URL(request.url, `http://${host}`).pathname : "";
      const context = {
        requestId: request.requestId,
        method: request.method,
        path: pathname,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
        ...(request.logContext || {})
      };
      if (pathname.startsWith("/api/") || response.statusCode >= 400) {
        const level = response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info";
        logger[level]("HTTP 请求完成", context);
      } else {
        logger.debug?.("HTTP 静态资源完成", context);
      }
    });
    try {
      const pathname = new URL(request.url, `http://${host}`).pathname;
      if (pathname.startsWith("/api/")) return await apiHandler(request, response, pathname);

      const replayAsset = resolveReplayAsset(pathname);
      if (replayAsset) return sendFile(response, replayAsset);

      const sceneAsset = resolveSceneAsset(pathname);
      if (sceneAsset) return sendFile(response, sceneAsset);

      if (pathname.startsWith("/assets/")) {
        const assetPath = safeFile(assetsDir, decodeURIComponent(pathname.slice("/assets/".length)));
        if (assetPath) return sendFile(response, assetPath);
      }

      const entry = pageEntry(pathname);
      if (entry) return sendFile(response, safeFile(publicDir, entry));

      const asset = publicAsset(pathname);
      const staticPath = asset ? safeFile(publicDir, decodeURIComponent(asset)) : null;
      if (staticPath) return sendFile(response, staticPath);

      response.writeHead(404);
      return response.end("Not found");
    } catch (error) {
      onError(error, { requestId: request.requestId, ...(request.logContext || {}) });
      if (response.headersSent) return response.destroy(error);
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify({ error: error.message || "服务异常" }));
    }
  };
}

module.exports = { createRouter, pageEntry, publicAsset, safeFile };
