function createSceneRoutes({ listScenes, readScene, sendJson }) {
  return async function scenesRoute(request, response, pathname) {
    if (request.method !== "GET") return false;
    if (pathname === "/api/scenes") {
      sendJson(response, 200, { scenes: listScenes() });
      return true;
    }
    if (!pathname.startsWith("/api/scenes/")) return false;
    const id = pathname.slice("/api/scenes/".length);
    if (!/^[a-z0-9-]+$/.test(id)) {
      sendJson(response, 400, { error: "场景地址无效" });
      return true;
    }
    const scene = readScene(id);
    sendJson(response, scene ? 200 : 404, scene || { error: "场景不存在" });
    return true;
  };
}

module.exports = { createSceneRoutes };
