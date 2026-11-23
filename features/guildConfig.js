/* ---------------------------------------------------------------------------
 * Per-server settings (chosen by admins in /serversettings).
 * Stored in the social document: social.guildConfig[guildId].
 * The activity channel itself stays where it always was (core guilds[id].channelId).
 * Every field has a default that matches how the bot behaved before.
 * ------------------------------------------------------------------------- */

const DEFAULTS = {
  // Activity feed
  ping: 'quiet', // 'quiet' = silent mention of whoever tracked the profile · 'off' = no mention
  postText: true, // AniList status posts & messages
  postManga: true, // manga / chapter updates
  mature: 'blur', // 18+ titles: 'show' · 'blur' (cover sent as a spoiler) · 'hide' (no cover) · 'skip'
  burst: 3, // flood protection: separate posts per person per check; the rest are bundled into one
  // Recaps
  recapChannelId: null, // null = same as the activity channel
  weeklyRecap: true,
  monthlyRecap: true,
  timezone: 'America/Toronto', // when weeks/months start for server recaps
  // Members
  autoTrack: true, // people who /signin here get tracked here automatically
  trackPerm: 'everyone', // who can /track others: 'everyone' | 'managers'
  relaunchPing: true, // ping the anime role when the bot restarts (max every 12h)
  animeRoleId: null, // null = a role named "anime"
  // Other
  nudges: true, // occasional "review us on Top.gg / send feedback" reminder
  leaderboards: null, // { board: bool } — null means defaults (see statsUi.BOARDS)
  lastWeekly: null,
  lastMonthly: null,
};

function guildConfig(social, guildId) {
  if (!guildId) return { ...DEFAULTS };
  const cfg = (social.guildConfig[guildId] ||= {});
  for (const [k, v] of Object.entries(DEFAULTS)) if (cfg[k] === undefined) cfg[k] = v;
  return cfg;
}

// Read without creating an entry.
function peekConfig(social, guildId) {
  return { ...DEFAULTS, ...(social.guildConfig?.[guildId] || {}) };
}

module.exports = { DEFAULTS, guildConfig, peekConfig };
