const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function json(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function createDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'training',
      coach_enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      lock_token TEXT,
      lock_until INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'opponent', 'coach')),
      content TEXT NOT NULL,
      speech_style TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(session_id, request_id, role)
    );
    CREATE INDEX IF NOT EXISTS messages_session_id_id ON messages(session_id, id);

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_version INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, message_version)
    );

    CREATE TABLE IF NOT EXISTS scene_jobs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL,
      message TEXT NOT NULL,
      prompt TEXT NOT NULL,
      voice TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      scene_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scene_jobs_status ON scene_jobs(status);
  `);

  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name);
  if (!sessionColumns.includes("mode")) {
    db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'training'");
  }
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
  if (!messageColumns.includes("speech_style")) {
    db.exec("ALTER TABLE messages ADD COLUMN speech_style TEXT NOT NULL DEFAULT ''");
  }

  const statements = {
    insertSession: db.prepare("INSERT INTO sessions (id, token_hash, scene_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"),
    getSessionByToken: db.prepare("SELECT * FROM sessions WHERE id = ? AND token_hash = ?"),
    getSessionById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    updateCoach: db.prepare("UPDATE sessions SET coach_enabled = ?, updated_at = ? WHERE id = ?"),
    claimSession: db.prepare("UPDATE sessions SET lock_token = ?, lock_until = ?, updated_at = ? WHERE id = ? AND (lock_until IS NULL OR lock_until < ?)"),
    releaseSession: db.prepare("UPDATE sessions SET lock_token = NULL, lock_until = NULL, updated_at = ? WHERE id = ? AND lock_token = ?"),
    insertMessage: db.prepare("INSERT OR IGNORE INTO messages (session_id, request_id, role, content, speech_style, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    getMessage: db.prepare("SELECT * FROM messages WHERE session_id = ? AND request_id = ? AND role = ?"),
    listMessages: db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id"),
    listArgumentMessages: db.prepare("SELECT * FROM messages WHERE session_id = ? AND role IN ('user', 'opponent') ORDER BY id"),
    listCoachMessages: db.prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'coach' ORDER BY id"),
    sessionCounts: db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_turns FROM messages WHERE session_id = ?"),
    messageVersion: db.prepare("SELECT COALESCE(MAX(id), 0) AS version FROM messages WHERE session_id = ? AND role IN ('user', 'opponent')"),
    getReport: db.prepare("SELECT * FROM reports WHERE session_id = ? AND message_version = ?"),
    saveReport: db.prepare("INSERT INTO reports (session_id, message_version, report_json, model, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, message_version) DO UPDATE SET report_json = excluded.report_json, model = excluded.model, created_at = excluded.created_at"),
    markReviewed: db.prepare("UPDATE sessions SET status = 'reviewed', updated_at = ? WHERE id = ?"),
    getJob: db.prepare("SELECT * FROM scene_jobs WHERE id = ?"),
    findJobByKey: db.prepare("SELECT * FROM scene_jobs WHERE idempotency_key = ?"),
    listRecoverableJobs: db.prepare("SELECT * FROM scene_jobs WHERE status NOT IN ('completed', 'failed') ORDER BY created_at"),
    saveJob: db.prepare(`
      INSERT INTO scene_jobs (id, idempotency_key, status, progress, message, prompt, voice, scene_id, scene_url, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, progress = excluded.progress, message = excluded.message,
        scene_url = excluded.scene_url, error = excluded.error, updated_at = excluded.updated_at
    `)
  };

  function mapSession(row) {
    if (!row) return null;
    const counts = statements.sessionCounts.get(row.id);
    return {
      id: row.id,
      sceneId: row.scene_id,
      mode: row.mode || "training",
      coachEnabled: Boolean(row.coach_enabled),
      status: row.status,
      messageCount: Number(counts?.total || 0),
      userTurnCount: Number(counts?.user_turns || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function mapMessage(row) {
    return row ? { id: Number(row.id), requestId: row.request_id, role: row.role, content: row.content, speechStyle: row.speech_style || "", createdAt: row.created_at } : null;
  }

  function mapJob(row) {
    if (!row) return null;
    return {
      id: row.id, idempotencyKey: row.idempotency_key, status: row.status,
      progress: Number(row.progress), message: row.message, prompt: row.prompt, voice: row.voice,
      sceneId: row.scene_id, sceneUrl: row.scene_url, error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  return {
    close() { db.close(); },

    createSession(sceneId, openingMessage, mode = "training", openingSpeechStyle = "") {
      const id = `session-${crypto.randomUUID()}`;
      const token = crypto.randomBytes(32).toString("base64url");
      const createdAt = nowIso();
      db.exec("BEGIN IMMEDIATE");
      try {
        statements.insertSession.run(id, hashToken(token), sceneId, mode, createdAt, createdAt);
        statements.insertMessage.run(id, "opening", "opponent", openingMessage, String(openingSpeechStyle).slice(0, 1000), createdAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { session: mapSession(statements.getSessionById.get(id)), token, messages: this.listMessages(id) };
    },

    authenticateSession(id, token) {
      return mapSession(statements.getSessionByToken.get(id, hashToken(token)));
    },

    getSession(id) {
      return mapSession(statements.getSessionById.get(id));
    },

    setCoachEnabled(id, enabled) {
      statements.updateCoach.run(enabled ? 1 : 0, nowIso(), id);
      return mapSession(statements.getSessionById.get(id));
    },

    claimSession(id, ttlMs = 90000) {
      const token = crypto.randomUUID();
      const now = Date.now();
      const result = statements.claimSession.run(token, now + ttlMs, nowIso(), id, now);
      return Number(result.changes) === 1 ? token : null;
    },

    releaseSession(id, lockToken) {
      statements.releaseSession.run(nowIso(), id, lockToken);
    },

    appendMessage(sessionId, requestId, role, content, speechStyle = "") {
      statements.insertMessage.run(sessionId, requestId, role, String(content).slice(0, 12000), String(speechStyle).slice(0, 1000), nowIso());
      return mapMessage(statements.getMessage.get(sessionId, requestId, role));
    },

    getMessage(sessionId, requestId, role) {
      return mapMessage(statements.getMessage.get(sessionId, requestId, role));
    },

    listMessages(sessionId) {
      return statements.listMessages.all(sessionId).map(mapMessage);
    },

    listArgumentMessages(sessionId) {
      return statements.listArgumentMessages.all(sessionId).map(mapMessage);
    },

    listCoachMessages(sessionId) {
      return statements.listCoachMessages.all(sessionId).map(mapMessage);
    },

    messageVersion(sessionId) {
      return Number(statements.messageVersion.get(sessionId)?.version || 0);
    },

    getReport(sessionId, version) {
      const row = statements.getReport.get(sessionId, version);
      return row ? { report: json(row.report_json, {}), model: row.model, createdAt: row.created_at } : null;
    },

    saveReport(sessionId, version, report, model) {
      statements.saveReport.run(sessionId, version, JSON.stringify(report), model, nowIso());
      statements.markReviewed.run(nowIso(), sessionId);
      return this.getReport(sessionId, version);
    },

    getJob(id) { return mapJob(statements.getJob.get(id)); },
    findJobByIdempotencyKey(key) { return mapJob(statements.findJobByKey.get(key)); },
    listRecoverableJobs() { return statements.listRecoverableJobs.all().map(mapJob); },
    saveJob(job) {
      const updatedAt = job.updatedAt || nowIso();
      statements.saveJob.run(job.id, job.idempotencyKey, job.status, job.progress, job.message, job.prompt, job.voice, job.sceneId, job.sceneUrl || null, job.error || null, job.createdAt, updatedAt);
      return this.getJob(job.id);
    }
  };
}

module.exports = { createDatabase };
