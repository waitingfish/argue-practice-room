const createdScenesKey = "argue-created-scenes";

const fallbackScenes = [
  {
    id: "restaurant",
    url: "/scene/restaurant",
    title: "臭烟子风波",
    art: "assets/restaurant-characters.png",
    createdAt: ""
  },
  {
    id: "family",
    url: "/scene/family",
    title: "家里那句没说出口的话",
    art: "assets/family-characters.png",
    createdAt: ""
  },
  {
    id: "night",
    url: "/scene/night",
    title: "深夜对峙",
    art: "assets/night-characters.png",
    createdAt: ""
  }
];

function readCreatedScenes() {
  try {
    const scenes = JSON.parse(localStorage.getItem(createdScenesKey) || "[]");
    return Array.isArray(scenes) ? scenes : [];
  } catch {
    return [];
  }
}

function sceneArtUrl(art) {
  const value = String(art || "");
  if (!value) return "assets/restaurant-characters.png";
  return value.startsWith("/") ? value : `/${value}`;
}

function formatCreatedAt(value) {
  if (!value) return "预制场景";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚创建";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function normalizedCreatedScenes() {
  const seen = new Set();
  return readCreatedScenes()
    .filter((scene) => scene && scene.url && scene.title)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .filter((scene) => {
      const key = scene.id || scene.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renderScenePick(scene, isGenerated) {
  const link = document.createElement("a");
  link.href = scene.url;
  link.className = isGenerated ? "generated-pick" : "fallback-pick";

  const image = document.createElement("img");
  image.src = sceneArtUrl(scene.art);
  image.alt = "";

  const title = document.createElement("span");
  title.textContent = scene.title;

  const time = document.createElement("small");
  time.textContent = formatCreatedAt(scene.createdAt);

  link.append(image, title, time);
  return link;
}

function renderCreatedScenes() {
  const list = document.querySelector("#localScenePicks");
  if (!list) return;

  const generated = normalizedCreatedScenes().slice(0, 3);
  const used = new Set(generated.map((scene) => scene.id || scene.url));
  const filler = fallbackScenes.filter((scene) => !used.has(scene.id)).slice(0, 3 - generated.length);
  const scenes = [...generated, ...filler];

  list.replaceChildren();
  scenes.forEach((scene, index) => {
    const item = renderScenePick(scene, index < generated.length);
    if (index === 0) item.classList.add("selected");
    list.append(item);
  });
}

renderCreatedScenes();
