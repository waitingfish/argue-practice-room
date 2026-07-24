function createAdminRoutes({
  readConfig,
  writeConfig,
  mergeConfig,
  validateConfig,
  publicConfig,
  isAdmin,
  getBody,
  sendJson
}) {
  return async function adminRoute(request, response, pathname) {
    const config = readConfig();
    if (pathname === "/api/status" && request.method === "GET") {
      sendJson(response, 200, {
        configured: Boolean(config.apiKey),
        model: config.model,
        transcriptionMode: config.transcriptionMode,
        speechMode: config.speechMode,
        immersiveConfigured: Boolean((config.speechApiKey || config.apiKey) && config.speechBaseUrl && config.transcriptionBaseUrl)
      });
      return true;
    }
    if (pathname !== "/api/admin/config") return false;
    if (!isAdmin(request, config)) {
      sendJson(response, 401, { error: "后台访问码不正确" });
      return true;
    }
    if (request.method === "GET") {
      sendJson(response, 200, publicConfig(config));
      return true;
    }
    if (request.method === "PUT") {
      const next = mergeConfig(config, await getBody(request));
      const error = validateConfig(next);
      if (error) sendJson(response, 400, { error });
      else {
        writeConfig(next);
        sendJson(response, 200, publicConfig(next));
      }
      return true;
    }
    return false;
  };
}

module.exports = { createAdminRoutes };
