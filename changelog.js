// What `/update` posts when no custom message is given. Edit this list
// whenever you ship something worth telling servers about.
const LATEST_UPDATE = {
  title: '✨ AniTracker update — Recaps, a new look & admin settings',
  items: [
    '**🆕 New activity posts** — Discord’s modern layout: the anime’s banner, your profile status, and a progress bar for the season you’re on (“episode 7 of 12 · 58%”)',
    '**🏷️ Real vibes, not vague genres** — posts and stats now use AniList tags like *Isekai*, *Satire* or *Iyashikei* instead of “Comedy, Adventure”',
    '**📅 Weekly & 🗓️ monthly server recaps** — every Monday and on the 1st: most hours, episodes, different anime, completions, streaks and the server favourite',
    '**🎁 Your monthly recap by DM** — with “share to a server” and “compare with another month”',
    '**🗓️ /recap** — the last 6 months show up as choices, no typing',
    '**🛡️ /serversettings** — admins pick the channel, recaps, leaderboards, auto-tracking, 18+ handling and more, plus a health check for profiles that aren’t posting',
    '**🔧 Fixed** — updates that AniList merges into an older activity (or that never make an activity) now post too',
  ],
  footer: 'Admins: try /serversettings · everyone: /recap',
};

module.exports = { LATEST_UPDATE };
