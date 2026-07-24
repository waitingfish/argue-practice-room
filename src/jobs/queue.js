function createQueue({ worker, onError = console.error }) {
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
          await worker(id);
        } catch (error) {
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
    setImmediate(drain);
    return true;
  }

  return Object.freeze({
    enqueue,
    stats: () => ({ queued: pending.length, processing })
  });
}

module.exports = { createQueue };
