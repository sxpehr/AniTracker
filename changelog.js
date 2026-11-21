// What `/update` posts when no custom message is given. Edit this list
// whenever you ship something worth telling servers about.
const LATEST_UPDATE = {
  title: '✨ AniTracker update — Leaderboards, rotation cards & recaps',
  items: [
    '**📺 Activity posts** — back to the classic look with your profile picture, now with your status, a progress bar for the season, AniList tags (*Isekai*, *Satire*…) and ⭐ Rate',
    '**🔄 In Rotation** — your profile shows what you’re watching as cards: cover in a progress ring, season, episodes, status and tags',
    '**🏆 Leaderboards** — profile pictures, progress bars and details for everyone, plus banners of what the server is watching',
    '**😳 Freakiest board** — now lists the shows behind the numbers (still off unless admins turn it on)',
    '**📅 Weekly & 🗓️ monthly recaps** — most hours with profile pictures, popular shows as banners',
    '**🛡️ Flood protection** — if a pile of updates builds up, the newest post on their own and the rest come as one “caught up” post (admins: /serversettings)',
    '**⭐ Ratings & 🔎 /watched** — progress bars and banners instead of stars and tiny covers',
  ],
  footer: 'Try /profile, /leaderboard and /recap · admins: /serversettings',
};

module.exports = { LATEST_UPDATE };
