function createSceneGenerationWorker({ run }) {
  return async function sceneGenerationWorker(jobId) {
    await run(jobId);
  };
}

module.exports = { createSceneGenerationWorker };
