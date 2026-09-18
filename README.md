# whoop-sync

Every morning at 09:00 IST a GitHub Action pulls the last 3 days from the WHOOP v2 API and upserts
one row per day into the Notion **WHOOP Daily** database. Zero dependencies, Node 20.

## Setup (one time, ~15 min)

1. **WHOOP app** — developer.whoop.com → Create app.
   Redirect URI: `http://localhost:8080/callback`.
   Scopes: `offline read:recovery read:sleep read:cycles read:workout read:profile`.
   Copy Client ID + Client Secret.

2. **Notion** — share the *WHOOP Daily* database with your existing "UPI Sync" integration
   (⋯ → Connections), or make a new internal integration. DB ID: `dfc13e5bc91b486998fb7d2df09a2377`.

3. **Local auth** (Mac):
   ```
   cp .env.example .env      # fill WHOOP_CLIENT_ID / SECRET / NOTION_TOKEN
   npm run auth              # opens consent URL → prints WHOOP_REFRESH_TOKEN
   npm run sync              # test: should print 3-4 days and create rows in Notion
   ```
   `npm run sync` prints a **new** refresh token each time — WHOOP rotates them. Always use the latest.

4. **GitHub** — push this repo (private). Settings → Secrets → Actions, add:
   `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REFRESH_TOKEN` (the latest one),
   `NOTION_TOKEN`, `NOTION_DB_ID`, and `REPO_PAT` — a fine-grained PAT scoped to this repo with
   **Secrets: Read and write** (used to rotate the refresh token after each run).

5. Actions tab → *whoop-sync* → **Run workflow** once to verify. Then forget about it.

## Notes
- Days are keyed on cycle start in Asia/Kolkata. Rows are upserted by Date, so re-runs are safe.
- If the refresh token ever expires (WHOOP revokes after long inactivity), rerun `npm run auth`
  and update the `WHOOP_REFRESH_TOKEN` secret.
- `DAYS_BACK=30 npm run sync` to backfill history.
