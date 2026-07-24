const { bindMethods } = require("./repository-utils");

const methods = [
  "getJob",
  "findJobByIdempotencyKey",
  "listRecoverableJobs",
  "saveJob"
];

function createSceneRepository(database) {
  return Object.freeze(bindMethods(database, methods));
}

module.exports = { createSceneRepository };
