const { bindMethods } = require("./repository-utils");

const methods = [
  "getReplay",
  "getReplayBySession",
  "saveReplay"
];

function createReplayRepository(database) {
  return Object.freeze(bindMethods(database, methods));
}

module.exports = { createReplayRepository };
