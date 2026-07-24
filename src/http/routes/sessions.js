function createSessionRoutes({ getBody, readScene, sessionService, sendJson }) {
  return async function sessionsRoute(request, response, pathname) {
    if (pathname !== "/api/sessions" || request.method !== "POST") return false;
    const payload = await getBody(request);
    const scene = readScene(String(payload.sceneId || ""));
    if (!scene) {
      sendJson(response, 404, { error: "场景不存在" });
      return true;
    }
    sendJson(response, 201, sessionService.create(scene, payload.mode));
    return true;
  };
}

module.exports = { createSessionRoutes };
