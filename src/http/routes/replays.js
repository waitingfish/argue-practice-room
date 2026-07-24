function createReplayRoutes({ replays, serialize, sendJson }) {
  return async function replaysRoute(request, response, pathname) {
    const match = pathname.match(/^\/api\/replays\/(replay-[a-f0-9]{24})$/);
    if (!match || request.method !== "GET") return false;
    const replay = replays.getReplay(match[1]);
    sendJson(response, replay ? 200 : 404, replay ? serialize(replay) : { error: "回放不存在或已被删除" });
    return true;
  };
}

module.exports = { createReplayRoutes };
