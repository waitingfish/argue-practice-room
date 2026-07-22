const fs = require("node:fs");
const path = require("node:path");
const { createDatabase } = require("../database");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const configPath = path.join(dataDir, "config.json");
const sceneConfigDir = path.join(root, "scene-configs");
const publishedScenesDir = path.join(sceneConfigDir, "generated");
const legacyScenesDir = path.join(dataDir, "scenes");
const legacyJobsDir = path.join(dataDir, "jobs");
const database = createDatabase(path.join(dataDir, "app.db"));

const currentSafetyPrompt = "目标是帮助用户坚定、清晰、不过度攻击地表达边界。不要羞辱、操纵或鼓励报复；遇到威胁、暴力或自伤风险时，停止角色扮演，建议立即联系可信任的人或当地紧急服务。全程用简体中文。";
const legacyDualRolePrompt = "你是“吵架练习室”的沟通教练。目标是帮助用户坚定、清晰、不过度攻击地表达边界。你同时扮演当前场景中的对方和复盘教练：先用一句符合场景的对方回应推进对话，再用“教练：”开头给出不超过 80 字的具体反馈。不要羞辱、操纵或鼓励报复；遇到威胁、暴力或自伤风险时，停止角色扮演，建议立即联系可信任的人或当地紧急服务。全程用简体中文。";

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function migrateConfig() {
  const config = readJson(configPath);
  if (!config) return { changed: false, message: "没有发现 data/config.json" };
  if (String(config.systemPrompt || "").trim() !== legacyDualRolePrompt) return { changed: false, message: "配置已经是当前结构" };
  config.systemPrompt = currentSafetyPrompt;
  writeJson(configPath, config);
  return { changed: true, message: "已把旧双角色 systemPrompt 迁移为补充安全原则" };
}

function migrateLegacyJobs() {
  if (!fs.existsSync(legacyJobsDir)) return { changed: false, message: "没有发现旧任务目录 data/jobs" };
  let imported = 0;
  for (const name of fs.readdirSync(legacyJobsDir)) {
    if (!name.endsWith(".json")) continue;
    const job = readJson(path.join(legacyJobsDir, name));
    if (job?.id && job.idempotencyKey && !database.getJob(job.id)) {
      database.saveJob(job);
      imported += 1;
    }
  }
  return { changed: imported > 0, message: `已导入旧任务 ${imported} 条到 SQLite` };
}

function migrateLegacyScenes() {
  if (!fs.existsSync(legacyScenesDir)) return { changed: false, message: "没有发现旧场景目录 data/scenes" };
  let migrated = 0;
  fs.mkdirSync(publishedScenesDir, { recursive: true });
  for (const name of fs.readdirSync(legacyScenesDir)) {
    if (!name.endsWith(".json")) continue;
    const scene = readJson(path.join(legacyScenesDir, name));
    const id = scene?.id || path.basename(name, ".json");
    if (!/^[a-z0-9-]+$/.test(id)) continue;
    const destination = path.join(publishedScenesDir, id);
    const scenePath = path.join(destination, "scene.json");
    if (fs.existsSync(scenePath)) continue;
    fs.mkdirSync(destination, { recursive: true });
    writeJson(scenePath, { ...scene, id, source: "generated" });
    migrated += 1;
  }
  return { changed: migrated > 0, message: `已迁移旧场景 ${migrated} 个到 scene-configs/generated` };
}

function migrateSceneVoices() {
  if (!fs.existsSync(publishedScenesDir)) return { changed: false, message: "没有发现已生成场景" };
  let migrated = 0;
  for (const id of fs.readdirSync(publishedScenesDir)) {
    const scenePath = path.join(publishedScenesDir, id, "scene.json");
    const scene = readJson(scenePath);
    if (!scene || scene.opponentGender) continue;
    const description = `${scene.intro || ""}${scene.opponentPrompt || ""}`;
    const male = /他|男性|男友|丈夫|父亲|哥哥|弟弟/.test(description);
    const female = /她|女性|女友|妻子|母亲|姐姐|妹妹/.test(description);
    scene.opponentGender = male && !female ? "male" : "female";
    writeJson(scenePath, scene);
    migrated += 1;
  }
  return { changed: migrated > 0, message: `已为历史生成场景补充对方性别 ${migrated} 个` };
}

function migrateSceneReferees() {
  const scenePaths = fs.existsSync(sceneConfigDir)
    ? fs.readdirSync(sceneConfigDir).filter((name) => name.endsWith(".json")).map((name) => path.join(sceneConfigDir, name))
    : [];
  if (fs.existsSync(publishedScenesDir)) {
    for (const id of fs.readdirSync(publishedScenesDir)) scenePaths.push(path.join(publishedScenesDir, id, "scene.json"));
  }
  let migrated = 0;
  for (const scenePath of scenePaths) {
    const scene = readJson(scenePath);
    if (!scene || (scene.winCondition && scene.refereePrompt)) continue;
    scene.winCondition ||= "对方明确接受用户提出的合理边界、具体请求或行动方案，并形成可观察的收束。";
    scene.refereePrompt ||= "重点检查对方是否真正让步或承诺行动；辱骂、压制、敷衍、沉默和单方面宣布胜利都不算赢。";
    writeJson(scenePath, scene);
    migrated += 1;
  }
  return { changed: migrated > 0, message: `已为历史场景补充裁判配置 ${migrated} 个` };
}

try {
  const results = [migrateConfig(), migrateLegacyJobs(), migrateLegacyScenes(), migrateSceneVoices(), migrateSceneReferees()];
  for (const result of results) console.log(`${result.changed ? "✓" : "-"} ${result.message}`);
} finally {
  database.close();
}
