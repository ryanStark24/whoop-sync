const API = "https://api.prod.whoop.com/developer/v2";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

/** Refresh the access token. WHOOP ROTATES refresh tokens: the returned one replaces the old one. */
export async function refresh(clientId, clientSecret, refreshToken) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: clientId, client_secret: clientSecret, scope: "offline",
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("WHOOP refresh failed: " + JSON.stringify(j));
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? refreshToken };
}

export class Whoop {
  constructor(accessToken) { this.h = { Authorization: `Bearer ${accessToken}` }; }

  async get(path, params = {}) {
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    // A backfill makes two calls per day of history; WHOOP allows about 100 a minute. On 429, wait as told and try again.
    let r = await fetch(u, { headers: this.h });
    for (let attempt = 0; r.status === 429 && attempt < 6; attempt++) {
      const wait = Number(r.headers.get("retry-after") ?? r.headers.get("x-ratelimit-reset") ?? 20);
      await new Promise((ok) => setTimeout(ok, Math.min(Math.max(wait, 5), 70) * 1000));
      r = await fetch(u, { headers: this.h });
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`WHOOP ${path} → ${r.status} ${await r.text()}`);
    return r.json();
  }

  /** Paginated collection fetch (limit ≤ 25 per page). */
  async all(path, start, end) {
    const out = []; let nextToken;
    do {
      const j = await this.get(path, { start, end, limit: 25, nextToken });
      out.push(...(j?.records ?? []));
      nextToken = j?.next_token;
    } while (nextToken);
    return out;
  }

  cycles(start, end)   { return this.all("/cycle", start, end); }
  workouts(start, end) { return this.all("/activity/workout", start, end); }
  cycleRecovery(id)    { return this.get(`/cycle/${id}/recovery`); }
  cycleSleep(id)       { return this.get(`/cycle/${id}/sleep`); }
}
