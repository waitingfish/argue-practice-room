(function exposeCreatedScenesStore(global) {
  const key = "argue-created-scenes";

  function read() {
    try {
      const scenes = JSON.parse(global.localStorage.getItem(key) || "[]");
      return Array.isArray(scenes) ? scenes : [];
    } catch {
      return [];
    }
  }

  function upsert(scene, limit = 12) {
    const identity = scene?.id || scene?.url;
    if (!identity) return read();
    const existing = read().filter((item) => (item.id || item.url) !== identity);
    const next = [scene, ...existing].slice(0, limit);
    global.localStorage.setItem(key, JSON.stringify(next));
    return next;
  }

  global.createdScenesStore = Object.freeze({ read, upsert });
})(window);
