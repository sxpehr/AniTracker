// Shared services for the feature modules, filled in once by index.js.
// (Avoids circular requires between index.js and the features.)
const ctx = {
  client: null,
  loadData: null,
  saveData: null,
  loadSocial: null,
  saveSocial: null,
  loadStats: null,
  saveStats: null,
  respond: null, // safe reply/editReply that never throws
  signInUrlFor: null,
  isOAuthConfigured: null,
};

function setup(deps) {
  Object.assign(ctx, deps);
}

module.exports = { ctx, setup };
