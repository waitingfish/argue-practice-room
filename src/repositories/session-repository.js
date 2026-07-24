const { bindMethods } = require("./repository-utils");

const methods = [
  "createSession",
  "authenticateSession",
  "getSession",
  "deleteSession",
  "setCoachEnabled",
  "claimSession",
  "releaseSession",
  "appendMessage",
  "beginTurn",
  "completeTurn",
  "failTurn",
  "getMessage",
  "getTurn",
  "listMessages",
  "listArgumentMessages",
  "listCoachMessages",
  "messageVersion",
  "getReport",
  "saveReport",
  "getVerdict",
  "getLatestVerdict",
  "saveVerdict"
];

function createSessionRepository(database) {
  return Object.freeze(bindMethods(database, methods));
}

module.exports = { createSessionRepository };
