const levels = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const configuredLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const activeLevel = levels[configuredLevel] || levels.info;

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function serializeError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    message: error.message || String(error),
    stack: error.stack
  };
}

function sanitize(value) {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/api[-_]?key|authorization|password|token|secret/i.test(key)) return [key, "[REDACTED]"];
    return [key, sanitize(item)];
  }));
}

function write(level, message, fields = {}) {
  if (levels[level] < activeLevel) return;
  const entry = sanitize({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields
  });
  const line = JSON.stringify(entry);
  if (level === "error") return console.error(line);
  if (level === "warn") return console.warn(line);
  return console.log(line);
}

const logger = Object.freeze({
  debug: (message, fields) => write("debug", message, fields),
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields)
});

module.exports = { logger, serializeError };
