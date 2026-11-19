# AniTracker — Profiles, Customization & Reviews update

Nothing to configure: push and Render deploys it. Slash commands register themselves on startup.
Everything below is **opt-in**. Anyone who never opens `/settings` sees the same activity posts as before.

## New commands
| Command | What it does |
|---|---|
| `/profile [user]` | Interactive anime profile with tabs: Overview · Favorites · Reviews · Recs · Collections · Stats · Activity |
| `/settings [section]` | The customization studio: Appearance, Profile, Showcase, Activity posts, Privacy, Stats & reviews, Server |
| `/review write · read · browse` | Write reviews in Discord, read them by anime, discover the newest, most helpful, highest rated, this server's, or your own |
| `/collection view · add · create · manage` | Favorites, Watch Later, Recommendations, In Rotation and custom lists |
| `/recommend anime [message]` | Recommend an anime with a personal note |
| `/stats [user]` | This month (with a 6-month sparkline), lifetime (from AniList), and streaks (with a heatmap) |
| `/recap [month] [user] [private]` | Shareable monthly recap with your #1 anime's banner |
| `/leaderboard [category]` | Server boards. Managers choose which ones in `/settings` → Server |

`/myfavorites` and `/watchlater` now open the full list managers (reorder, notes, feature, mark started).

## How it's built (and why it looks different from embeds)
- **Components V2.** Profiles, settings, reviews and stats use Discord's newer layout system instead of embeds. It allows real cover galleries (up to 10), thumbnails beside text, dividers, and buttons and menus inside the card. Every message is checked against Discord's limits (40 components, 4,000 characters). If a profile has more sections switched on than fit, whole sections drop from the bottom (they're still on the tabs) instead of the message failing.
- **Painted banners.** Discord cards can't have a background colour, so each theme also paints a banner image from its colours: a gradient with a glow, orbit rings and ✦ sparkles. The bot serves it from its own URL (`/banner/...`), so Discord fetches it once and caches it. The "Featured anime" banner uses that anime's AniList banner tinted with your theme.
- **Menus are AniList blue.** Settings, list managers, search results and leaderboards use the AniList-blue accent (#3DB4F2). Profiles, reviews and recaps use the owner's own theme colour.
- **Draft + live preview.** In `/settings`, every change goes into a draft and the preview card underneath updates instantly. Nothing applies until **Save**, and **Discard** undoes it. Activity posts get their own **📡 Preview a post** button.
- **Favorite Anime Opening.** You search for the anime, then pick its OP from the list on AnimeThemes (song, artist, episodes). The profile shows it with a ▶️ Play button. If AnimeThemes doesn't have it, you can type it in.
- **Activity post buttons** are now two rows: 💜 Recommend · ❤️ Like · ⭐ Favorite · 📌 Watch later / ✍️ Review · ➕ Save to list · 📊 More info. Old posts switch to the new buttons the next time someone clicks Recommend on them.
- **Stats** are recorded by the poller once per AniList account. That includes people who signed in with `/signin` but aren't tracked anywhere. Duplicate logs aren't double-counted, and "completed" fills in the final episodes. Lifetime totals come straight from AniList, so nothing is duplicated. Streaks follow each person's time zone (set in `/settings`, default Toronto).
- **Storage:** profiles and reviews live in a new Redis key `anitracker:social`, and watch history in `anitracker:stats`. That keeps each write small. Existing Watch Later and Favorites lists were moved over automatically.

## Checklist (✅ covered by the automated run: 119 messages validated against Discord's limits)
- ✅ Default profile and onboarding nudge for people who haven't customized
- ✅ Settings: all 7 categories, theme, custom hex colours (with validation), 4 banner modes, text form, featured anime (from favorites or search), favorite opening, showcase sections + 4 layouts, post style / colour / details, privacy, time zone, recap DM, spoiler default, server leaderboards, save, discard, previews
- ✅ Lists: add from posts, paging, reorder, notes, feature, remove, custom collections (create, edit, delete), "save to lists" multi-select, Watch Later → started → In Rotation, rotation pins and hides
- ✅ Recommend button + `/recommend` with a message, ❤️ Like, bookmarking someone's rec into your Watch Later
- ✅ Reviews: form from the post button, spoiler hiding, helpful votes (not your own), 5 browse sorts, read by anime with community score, share, feature, delete
- ✅ Stats engine (ranges, duplicates, completions, rewatches, streaks), `/stats` tabs, `/recap`, leaderboards respecting server config and privacy
- ✅ Profile with everything on, all 7 tabs, private copies when someone clicks your public profile, privacy (hidden parts, private profile)
- ✅ Autocomplete (anime search, months), monthly recap DMs, banner endpoint
- 🔲 Check live: how banners and cover galleries look in your Discord client (desktop and mobile)
- 🔲 Check live: the AnimeThemes opening list for a couple of shows

---

# Previous update — November (stability, sign-in, feedback)

## What you need to do (in order)

### 1. Drop these files into your repo, then push
Replace or add every file in this bundle at the same path. New files: `oauth.js`, `moreInfo.js`, `feedback.js`, `commands.js`, `UPDATE-NOTES.md`.

### 2. Turn on AniList sign-in (needed for `/signin` and `/tracking`)
1. Go to **https://anilist.co/settings/developer** → **Create New Client**
2. Name: `AniTracker`
3. Redirect URL: `https://<your-render-url>/auth/anilist/callback`
   (the same URL your dashboard is on, e.g. `https://anitracker-xxxx.onrender.com/auth/anilist/callback`)
4. Save, then copy the **Client ID** and **Client Secret**

### 3. Add env vars on Render (Service → Environment)
| Key | Value |
|---|---|
| `ANILIST_CLIENT_ID` | from step 2 |
| `ANILIST_CLIENT_SECRET` | from step 2 |
| `PUBLIC_URL` | optional, Render fills `RENDER_EXTERNAL_URL` for you. Only set it if you use a custom domain |

Make sure `DASHBOARD_SESSION_SECRET` is already set. It also signs the sign-in links.

### 4. Discord Developer Portal: required permissions + public install
**Bot tab**
- **Public Bot** → ON
- **Requires OAuth2 Code Grant** → OFF. If this is on, or Public Bot is off, Discord shows the "private application cannot have a default authorization link" error and the install button breaks.
- Privileged Gateway Intents: leave all OFF (none are needed)

**Installation tab**
- Installation Contexts: ✅ **Guild Install** (untick User Install)
- Install Link: **Discord Provided Link**
- Default Install Settings → Guild Install
  - Scopes: `applications.commands`, `bot`
  - Permissions: View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions, Use External Emojis
- Save Changes

These permissions make the permissions integer `274878286912`. The bot also prints the matching invite link in its logs on startup. The dashboard (Overview → "Invite link") and `/help` show it too.

### 5. Slash commands register themselves
The bot now syncs its global slash commands from `commands.js` every time it starts, so there's no more `npm run deploy-commands` after a deploy. New commands: `/feedback`, `/signin`, `/signout`, `/tracking`, `/help`. (If you ever registered commands to a test server with `GUILD_ID`, you may see duplicates there. Kick and re-invite the bot, or clear that server's commands.)

### 6. (Recommended) Stop committing node_modules
`node_modules/` is in `.gitignore` but ~5,000 files are still tracked from before. Render installs dependencies itself, so run this once:
```powershell
git rm -r --cached node_modules
git commit -m "Stop tracking node_modules"
```

---

## Why the bot kept restarting, and what changed

I can't see your Render logs, so here are the causes I found in the code, all now fixed. **Render → your service → Events/Logs** shows which one actually hit you. "Out of memory" there means cause 3.

1. **Crashes from errors nobody caught (most likely cause).** Node shuts the process down when an async error goes uncaught, and Render then restarts it. Several paths could do that:
   - `/untrack`, `/list`, `/setchannel`, `/watchlater`, `/myfavorites` and `/recommendanimes` replied without `await`. If the interaction had expired (common when Upstash was slow, because every command loaded from Upstash *before* replying), the failed reply crashed the bot.
   - Async dashboard routes could throw into nothing (Express 4 doesn't catch them).
   - The Discord client had no `error` listener. Node throws on an unhandled `error` event.
   - **Fix:** every reply goes through a safe `respond()`, dashboard routes are wrapped, the client has error listeners, and a process-wide safety net logs instead of dying.
2. **Hung AniList requests.** AniList calls had no timeout, so one stuck request could freeze the poller forever. **Fix:** 12s timeouts, plus one retry when AniList rate-limits (429).
3. **Memory on Render's 512 MB free tier.** Every post decoded the full-size cover with Jimp just to pick the embed colour, and the season cache grew forever. **Fix:** colour now comes from the smallest cover (same colour) and is cached. All caches are capped, and memory is logged every 15 min with caches cleared if it climbs past ~380 MB.
4. **Restarts were made louder by the @Anime ping.** That ping fired on every restart, including every GitHub push (Render auto-deploys). It now sends at most once every 12 hours.

**New: restart history.** The dashboard Overview now lists recent restarts, each marked "Clean stop" (a deploy) or "Crashed / killed" (crash or out-of-memory). It also shows `/health` for UptimeRobot (`https://<url>/health`).

### Storage is safer too
- **Lost changes.** Before, a slow poll could overwrite a Favorite or Recommend someone clicked while it ran. Now everything shares one in-memory copy, and Upstash saves are batched and written in order.
- **Possible data wipe.** If Upstash failed at boot, the old code "started fresh" and could save an empty blob over your real data. Now it retries and refuses to save until it has really loaded.
- **Last change lost on redeploy.** Pending saves are now flushed when Render stops the bot (SIGTERM).

---

## New features

### `/feedback`
- Opens a Discord form with a **rating (1–5 ★, required)**, a **title (required)** and a **message (required)**.
- Gives the user a private thank-you card. Each user can send once per minute.
- Stored with the rest of the bot data and shown in **Developer Portal → Feedback**, next to your website feedback. Those entries are tagged `/feedback`, with the user's avatar and name, the server, the title, and a **Delete** button. Resolve / Dispute / Keep for Later work as before.

### `/signin`, `/signout`, `/tracking`
- `/signin` sends a private "Sign in with AniList" button. After approving on AniList, the user lands on a styled confirmation page and gets a DM. The bot only stores AniList id, name, avatar and link. The access token is thrown away right after.
- `/tracking` (or `/tracking status:On/Off`) shows a private panel with a toggle. **Only the signed-in owner of that AniList account can change it.** It applies in every server. While it's off, nothing posts. Turning it back on starts from their next update, so nothing from the "off" period gets dumped.
- Signing in also makes the person the "owner" of their profile for reaction and recommend DMs, and lets them `/untrack` themselves.
- The dashboard's **Linked AniList Accounts** tab is now real, and Tracked Users shows 🔐 linked and "Live activity off".

### ℹ️ More Info button (4th button on every activity post)
Private to whoever clicks it. It shows:
- Cover thumbnail plus banner image, format and status, alt title, and a spoiler-free synopsis
- Episodes and length, **seasons ("Season 2 of 4")**, aired dates, a live next-episode countdown, score, popularity rank and members, studio, source, favourites, genres, and non-spoiler tags
- **Main Cast**: three character portraits in a gallery, with voice actors
- Buttons: **🎬 Trailer** (falls back to a YouTube search if AniList has none), **📡 Watch on Crunchyroll/Netflix/…** when AniList lists one, **AniList**, **MyAnimeList**
- Manga shows chapters and volumes instead

### Reaction DM alerts
Both DMs are now embeds with the **anime cover**, the **server name and icon**, the channel, and a **Jump to post** button. Toggling the same reaction no longer spams DMs (10-minute dedupe). Recommend DMs got the same treatment.

---

## Polish checklist

✅ = covered by my automated test run (mocked Discord + AniList). 🔲 = check live after deploying.

### Activity posts and embed buttons
- ✅ Buttons in order: ⭐ Recommend (blue) · 🤍 Favorite (red, Discord has no pink) · 📌 Watch later · ℹ️ More Info
- ✅ Recommend updates the count on the button and the footer, and **keeps the More Info button** after the edit
- ✅ Recommend: one global vote per person, DMs the owner (embed + cover + server)
- ✅ Watch later / Favorite toggle on and off, with clearer replies ("Added X (5 total)")
- ✅ **Watch later and Favorites are now one list per person across all servers.** They used to be separate per server, so `/watchlater` showed different things in different servers. Existing lists were merged automatically, so nothing is lost.
- ✅ More Info shows the actual season watched, with seasons counted correctly (a movie between seasons is skipped)
- ✅ "episodes 3 - 4" for merged updates (was "episode 3 - 4")
- ✅ Manga posts say "chapter", and never "season"
- ✅ Season number no longer counts movies/OVAs ("season 3" when it's really season 2)
- ✅ No double posts when a poll runs long (overlap guard), and a failure halfway through a batch never re-posts the earlier ones
- ✅ The same AniList profile tracked in several servers is fetched once per poll, not once per server
- ✅ Spoiler blocks stripped from synopses and status posts
- 🔲 Old posts (from before this update) keep their 3 buttons. They pick up More Info the next time someone clicks Recommend on them.

### Commands
- ✅ `/list` no longer **pings** everyone listed (it did before). It's now an embed with ⏸️ for profiles whose live activity is off.
- ✅ `/untrack` restricted to whoever tracked it, the signed-in owner, or Manage Server (before, anyone could untrack anyone)
- ✅ `/track` catches duplicates by AniList id (not just name casing), warns if the bot can't post in the channel, and warns if the owner has live activity off
- ✅ `/track`, `/favorites`, More Info: clear "AniList is down (their side)" message instead of "Something went wrong"
- ✅ An AniList "user not found" now says not found (AniList returns a 404, which used to show as a generic error)
- ✅ `/setchannel` only offers text/announcement channels, checks the bot's permissions there, and is hidden from non-managers in the command list
- ✅ `/recommendanimes` dropdown: only the person who ran it changes the shared message. Others get a private copy.
- ✅ `/favorites` shows the avatar and numbered lists
- ✅ New `/help` with an "Add to server" button
- ✅ All commands are server-only in Discord's command picker
- ✅ A welcome message with quick start goes to the system channel when the bot joins a new server

### Dashboard
- ✅ **Bug fix:** clicking a Feedback tab also triggered the Leaderboard tabs (shared `.tab` selector)
- ✅ A failed load shows an error instead of loading shimmers forever
- ✅ Discord ids now show as usernames (Tracked Users, Activity, Watch Later, Linked)
- ✅ Most Recommended uses the real global (deduped) tally
- ✅ Overview adds: linked accounts, RAM, storage health, invite link, restart history
- ✅ Activity rows show covers
- ✅ Login uses a constant-time password check
- ✅ Send Message can't accidentally ping @everyone (user and role mentions still work), and is capped at 2000 characters
- 🔲 Take a quick look at the new Feedback card layout once there's a real submission

### Things that are Discord/AniList limits, not bugs
- Discord forms have no star widget, so the rating is a dropdown of ★★★★★ options.
- Discord has no pink button colour. Favorite stays red.
- The cast "gallery" uses Discord's behaviour of merging embeds that share a link. It shows side by side on desktop and stacks on some mobile layouts.
- AniList's occasional 403 "temporarily disabled" errors are on AniList's side. The bot now logs them and moves on.
