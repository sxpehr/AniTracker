# TV Tracker: movies and TV setup

This bot was forked from AniTracker and changed to track movies and TV shows
through Simkl. Anime is not included.

## What changed
- **Data source:** Simkl replaces AniList. Lookups and watch activity both come from Simkl.
- **Sign-in:** `/signin` gives a short code to enter at simkl.com. No redirect URL, no website step.
- **Tracking:** `/track user:@someone` works for people who have run `/signin`. Only watches from that moment on post, so nothing old is dumped into chat.
- **New:** `/find` looks up any movie or show, with a poster card and Watch later / Favorite / Recommend / More info buttons.
- **Removed:** `/favorites` (it read AniList favourites) and the AniList-only `/recommendanimes` (now `/recommend`).
- **Reset on upgrade:** old AniList tracked entries, sign-ins, recommendations, watch later and favorites are cleared once, on first start. This happens only once.

## Steps
1. **Create or reuse a Simkl app.** Go to https://simkl.com/settings/developer. Copy the Client ID. Make sure device sign-in is allowed for the app.
2. **Set environment variables** on Render (Service → Environment):
   | Key | Value |
   |---|---|
   | `SIMKL_CLIENT_ID` | from step 1 |
   | `PING_ROLE_NAME` | optional. The role pinged on restart (default `tv`) |
   | `DASHBOARD_PASSWORD`, `DASHBOARD_SESSION_SECRET` | as before |
   | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | as before |
   Remove `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` and `OAUTH_STATE_SECRET`. They are no longer used.
3. **Discord:** the permissions and install settings are the same as before.
4. **Deploy.** Slash commands register themselves on startup.

## Notes
- Simkl sign-in tokens are stored with the rest of the bot data. Keep the Upstash database private.
- Simkl's public API doesn't offer a watch history lookup without a sign-in, so only people who run `/signin` can be tracked.
- The poster URL format and the sign-in account lookup are based on Simkl's docs and have not been tested against a live account yet. Check the first `/signin` and `/track` run.
