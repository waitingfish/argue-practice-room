const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const roots = ["server.js", "database.js", "src", "public", "scripts"];
const ignored = new Set(["node_modules", "data", ".git", ".local", "tmp"]);
const files = [];

function collect(entry) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) return;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (absolute.endsWith(".js")) files.push(absolute);
    return;
  }
  for (const name of fs.readdirSync(absolute)) {
    if (!ignored.has(name)) collect(path.relative(root, path.join(absolute, name)));
  }
}

for (const entry of roots) collect(entry);

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`syntax ok (${files.length} files)`);
