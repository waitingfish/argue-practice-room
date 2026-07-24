const { serializeError } = require("../logger");

function createQueue({ worker, onError = console.error, logger = console }) {
  const pending = [];
  const queued = new Set();
  let processing = false;

  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (pending.length) {
        const id = pending.shift();
        queued.delete(id);
        try {
          const startedAt = Date.now();
          logger.info?.("队列任务开始", { jobId: id, pending: pending.length });
          await worker(id);
          logger.info?.("队列任务完成", { jobId: id, durationMs: Date.now() - startedAt, pending: pending.length });
        } catch (error) {
          logger.error?.("队列任务异常", { jobId: id, error: serializeError(error) });
          onError(error, id);
        }
      }
    } finally {
      processing = false;
    }
  }

  function enqueue(id) {
    if (queued.has(id)) return false;
    queued.add(id);
    pending.push(id);
    logger.info?.("队列任务入队", { jobId: id, pending: pending.length });
    setImmediate(drain);
    return true;
  }

  return Object.freeze({
    enqueue,
    stats: () => ({ queued: pending.length, processing })
  });
}

module.exports = { createQueue };
