const { createDatabase } = require("./database");
const { createSessionRepository } = require("./session-repository");
const { createSceneRepository } = require("./scene-repository");
const { createReplayRepository } = require("./replay-repository");

function createRepositories(filePath) {
  const database = createDatabase(filePath);
  const sessions = createSessionRepository(database);
  const scenes = createSceneRepository(database);
  const replays = createReplayRepository(database);
  return {
    sessions,
    scenes,
    replays,
    close: database.close.bind(database)
  };
}

module.exports = { createRepositories };
