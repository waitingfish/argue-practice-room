const fallbackPresetScenes = [
  { id: "restaurant-smoking", title: "餐厅。邻座刚点起一根烟。", art: "assets/restaurant-smoking/home-card.webp", url: "/scene/restaurant-smoking" },
  { id: "phone-night", title: "深夜。你准备找她沟通。", art: "assets/sketch-default/home-card.webp", url: "/scene/phone-night" },
  { id: "roommate-gaming", title: "合租房。室友还在打游戏。", art: "assets/roommate-gaming/home-card.webp", url: "/scene/roommate-gaming" }
];
const presetSlotClasses = ["left-scene", "center-scene", "right-scene"];
let presetScenes = fallbackPresetScenes;
let presetStartIndex = 0;

function sceneArtUrl(art) {
  const value = String(art || "");
  if (!value) return "assets/sketch-default/home-card.webp";
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
  return window.createdScenesStore.read()
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

function presetSceneTitle(scene) {
  return String(scene.kicker || scene.title || scene.intro || "预制场景").replace(/。$/, "");
}

function renderPresetScene(scene, slotIndex = 0) {
  const link = document.createElement("a");
  link.className = `hero-scene default-scene ${presetSlotClasses[slotIndex] || ""}`.trim();
  link.href = scene.url || `/scene/${scene.id}`;

  const image = document.createElement("img");
  image.src = sceneArtUrl(scene.art);
  image.alt = scene.title || "";

  const title = document.createElement("span");
  title.textContent = presetSceneTitle(scene);

  link.append(image, title);
  return link;
}

function visiblePresetScenes() {
  const visibleCount = Math.min(3, presetScenes.length);
  return Array.from({ length: visibleCount }, (_, slotIndex) => {
    const sceneIndex = (presetStartIndex + slotIndex) % presetScenes.length;
    return renderPresetScene(presetScenes[sceneIndex], slotIndex);
  });
}

function scrollPresetScenes(direction) {
  const gallery = document.querySelector("#presetSceneGallery");
  if (!gallery) return;
  if (presetScenes.length <= 1) return;
  presetStartIndex = (presetStartIndex + direction + presetScenes.length) % presetScenes.length;
  gallery.replaceChildren(...visiblePresetScenes());
  updatePresetNav();
}

function updatePresetNav() {
  const gallery = document.querySelector("#presetSceneGallery");
  const prev = document.querySelector(".scene-nav-prev");
  const next = document.querySelector(".scene-nav-next");
  if (!gallery || !prev || !next) return;
  const hasMultipleScenes = presetScenes.length > 1;
  prev.disabled = !hasMultipleScenes;
  next.disabled = !hasMultipleScenes;
}

async function renderPresetScenes() {
  const gallery = document.querySelector("#presetSceneGallery");
  if (!gallery) return;

  let scenes = fallbackPresetScenes;
  try {
    const response = await fetch("/api/scenes", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.scenes) && data.scenes.length > 0) scenes = data.scenes;
    }
  } catch {
    scenes = fallbackPresetScenes;
  }

  presetScenes = scenes;
  presetStartIndex = 0;
  gallery.dataset.count = String(scenes.length);
  gallery.replaceChildren(...visiblePresetScenes());
  updatePresetNav();
}

function bindPresetCarousel() {
  const gallery = document.querySelector("#presetSceneGallery");
  const prev = document.querySelector(".scene-nav-prev");
  const next = document.querySelector(".scene-nav-next");
  if (!gallery || !prev || !next) return;

  prev.addEventListener("click", () => scrollPresetScenes(1));
  next.addEventListener("click", () => scrollPresetScenes(-1));
  window.addEventListener("resize", updatePresetNav);
  updatePresetNav();
}

function renderCreatedScenes() {
  const list = document.querySelector("#localScenePicks");
  const section = document.querySelector("#localSceneSection");
  if (!list) return;

  const generated = normalizedCreatedScenes().slice(0, 3);
  list.replaceChildren();
  if (section) section.hidden = generated.length === 0;

  generated.forEach((scene, index) => {
    const item = renderScenePick(scene, true);
    if (index === 0) item.classList.add("selected");
    list.append(item);
  });
}

bindPresetCarousel();
renderPresetScenes();
renderCreatedScenes();
