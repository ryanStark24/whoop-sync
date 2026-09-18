/**
 * whoop-sync — pulls WHOOP v2 recovery / sleep / strain / workouts and upserts
 * one row per day into a Notion database. Runs on a daily cron; also exposes:
 *   GET  /auth           → start WHOOP OAuth (one-time)
 *   GET  /callback       → OAuth redirect target; stores tokens in KV
 *   POST /sync?key=…     → run a sync on demand (SYNC_KEY secret)
 *   GET  /status         → last run summary
 */

export interface Env {
  TOKENS: KVNamespace;
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
  NOTION_TOKEN: string;
  NOTION_DB_ID: string;
  SYNC_KEY: string;
  DAYS_BACK: string;
}

const WHOOP_API = "https://api.prod.whoop.com/developer/v2";
const WHOOP_AUTH = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";
const SCOPES = "offline read:recovery read:sleep read:workout read:cycles read:profile";
const NOTION = "https://api.notion.com/v1";
const TZ = "Asia/Kolkata";

// ---------- HTTP entry ----------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const redirectUri = `${url.origin}/callback`;

    if (url.pathname === "/auth") {
      const state = crypto.randomUUID();
      await env.TOKENS.put("oauth_state", state, { expirationTtl: 600 });
      const u = new URL(WHOOP_AUTH);
      u.searchParams.set("client_id", env.WHOOP_CLIENT_ID);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPES);
      u.searchParams.set("state", state);
      return Response.redirect(u.toString(), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const expected = await env.TOKENS.get("oauth_state");
      if (!code || !state || state !== expected) return new Response("Bad state/code", { status: 400 });
      const tok = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
      await saveTokens(env, tok);
      return new Response("WHOOP connected. You can close this tab. Trigger a sync with POST /sync?key=…", { status: 200 });
    }

    if (url.pathname === "/sync" && req.method === "POST") {
      if (url.searchParams.get("key") !== env.SYNC_KEY) return new Response("Forbidden", { status: 403 });
      const summary = await runSync(env);
      return Response.json(summary);
    }

    if (url.pathname === "/status") {
      const last = await env.TOKENS.get("last_run");
      const hasTok = !!(await env.TOKENS.get("refresh_token"));
      return Response.json({ connected: hasTok, last_run: last ? JSON.parse(last) : null });
    }

    return new Response("whoop-sync: /auth · /callback · POST /sync?key= · /status", { status: 200 });
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSync(env));
  },
};

// ---------- OAuth ----------
async function tokenRequest(env: Env, params: Record<string, string>) {
  const body = new URLSearchParams({
    client_id: env.WHOOP_CLIENT_ID, client_secret: env.WHOOP_CLIENT_SECRET, ...params,
  });
  const r = await fetch(WHOOP_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return r.json<{ access_token: string; refresh_token: string; expires_in: number }>();
}

async function saveTokens(env: Env, t: { access_token: string; refresh_token: string; expires_in: number }) {
  await env.TOKENS.put("access_token", t.access_token, { expirationTtl: Math.max(60, t.expires_in - 60) });
  await env.TOKENS.put("refresh_token", t.refresh_token); // rotates on every refresh — always persist the new one
}

async function accessToken(env: Env): Promise<string> {
  const cached = await env.TOKENS.get("access_token");
  if (cached) return cached;
  const refresh = await env.TOKENS.get("refresh_token");
  if (!refresh) throw new Error("Not connected — open /auth first");
  const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refresh, scope: "offline" });
  await saveTokens(env, t);
  return t.access_token;
}

// ---------- WHOOP ----------
async function whoopGet<T>(env: Env, path: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  do {
    const u = new URL(WHOOP_API + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (next) u.searchParams.set("nextToken", next);
    u.searchParams.set("limit", "25");
    const r = await fetch(u, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
    if (r.status === 401) { await env.TOKENS.delete("access_token"); continue; }
    if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
    const j = await r.json<{ records: T[]; next_token?: string }>();
    out.push(...j.records);
    next = j.next_token;
  } while (next);
  return out;
}

type Cycle = { id: number; start: string; end?: string; score_state: string; score?: { strain: number; kilojoule: number; average_heart_rate: number; max_heart_rate: number } };
type Recovery = { cycle_id: number; sleep_id: string; score_state: string; score?: { recovery_score: number; resting_heart_rate: number; hrv_rmssd_milli: number; spo2_percentage?: number; skin_temp_celsius?: number } };
type Sleep = { id: string; start: string; end: string; nap: boolean; score_state: string; score?: { stage_summary: { total_in_bed_time_milli: number; total_awake_time_milli: number; total_light_sleep_time_milli: number; total_slow_wave_sleep_time_milli: number; total_rem_sleep_time_milli: number }; sleep_performance_percentage?: number; sleep_consistency_percentage?: number; sleep_efficiency_percentage?: number; respiratory_rate?: number } };
type Workout = { id: string; start: string; end: string; sport_name?: string; sport_id?: number; score_state: string; score?: { strain: number; average_heart_rate: number; max_heart_rate: number; kilojoule: number } };

// ---------- Sync ----------
async function runSync(env: Env) {
  const days = Number(env.DAYS_BACK || "3");
  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  const end = new Date().toISOString();

  const [cycles, recoveries, sleeps, workouts] = await Promise.all([
    whoopGet<Cycle>(env, "/cycle", { start, end }),
    whoopGet<Recovery>(env, "/recovery", { start, end }),
    whoopGet<Sleep>(env, "/activity/sleep", { start, end }),
    whoopGet<Workout>(env, "/activity/workout", { start, end }),
  ]);

  const recByCycle = new Map(recoveries.map(r => [r.cycle_id, r]));
  const sleepById = new Map(sleeps.map(s => [s.id, s]));
  let upserted = 0;

  for (const c of cycles) {
    const rec = recByCycle.get(c.id);
    const slp = rec ? sleepById.get(rec.sleep_id) : undefined;
    const day = istDate(c.start);
    const cycleStart = new Date(c.start).getTime();
    const cycleEnd = c.end ? new Date(c.end).getTime() : Date.now();
    const wos = workouts.filter(w => { const t = new Date(w.start).getTime(); return t >= cycleStart && t < cycleEnd; });

    const h = (ms?: number) => ms == null ? null : round(ms / 3_600_000, 2);
    const ss = slp?.score?.stage_summary;
    const sleepHours = ss ? h(ss.total_in_bed_time_milli - ss.total_awake_time_milli) : null;

    const props: Record<string, unknown> = {
      Name: title(day),
      Date: { date: { start: day } },
      "Cycle ID": rt(String(c.id)),
      Recovery: num(rec?.score?.recovery_score),
      HRV: num(rec?.score?.hrv_rmssd_milli, 1),
      RHR: num(rec?.score?.resting_heart_rate),
      SpO2: num(rec?.score?.spo2_percentage, 1),
      "Skin Temp": num(rec?.score?.skin_temp_celsius, 2),
      "Sleep Hours": num(sleepHours),
      "Sleep Performance": num(slp?.score?.sleep_performance_percentage),
      "Sleep Efficiency": num(slp?.score?.sleep_efficiency_percentage, 1),
      "Sleep Consistency": num(slp?.score?.sleep_consistency_percentage),
      "REM Hours": num(h(ss?.total_rem_sleep_time_milli)),
      "Deep Hours": num(h(ss?.total_slow_wave_sleep_time_milli)),
      "Light Hours": num(h(ss?.total_light_sleep_time_milli)),
      "Awake Hours": num(h(ss?.total_awake_time_milli)),
      "Respiratory Rate": num(slp?.score?.respiratory_rate, 1),
      Strain: num(c.score?.strain, 1),
      Calories: num(c.score ? c.score.kilojoule / 4.184 : undefined, 0),
      "Avg HR": num(c.score?.average_heart_rate),
      "Max HR": num(c.score?.max_heart_rate),
      Workouts: rt(wos.map(w => {
        const mins = Math.round((new Date(w.end).getTime() - new Date(w.start).getTime()) / 60_000);
        return `${w.sport_name ?? "Workout"} ${mins}m` + (w.score ? ` · strain ${round(w.score.strain, 1)}` : "");
      }).join("; ")),
    };
    // drop nulls so Notion doesn't complain
    for (const k of Object.keys(props)) if (props[k] == null) delete props[k];

    await upsert(env, String(c.id), props);
    upserted++;
  }

  const summary = { at: new Date().toISOString(), cycles: cycles.length, upserted };
  await env.TOKENS.put("last_run", JSON.stringify(summary));
  return summary;
}

// ---------- Notion ----------
async function notion(env: Env, path: string, method: string, body?: unknown) {
  const r = await fetch(NOTION + path, {
    method,
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`notion ${path} ${r.status}: ${await r.text()}`);
  return r.json<any>();
}

async function upsert(env: Env, cycleId: string, properties: Record<string, unknown>) {
  const q = await notion(env, `/databases/${env.NOTION_DB_ID}/query`, "POST", {
    filter: { property: "Cycle ID", rich_text: { equals: cycleId } }, page_size: 1,
  });
  if (q.results?.length) {
    await notion(env, `/pages/${q.results[0].id}`, "PATCH", { properties });
  } else {
    await notion(env, `/pages`, "POST", { parent: { database_id: env.NOTION_DB_ID }, properties });
  }
}

// ---------- helpers ----------
const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const num = (v?: number | null, d = 0) => v == null ? null : { number: round(v, d) };
const rt = (s: string) => ({ rich_text: [{ text: { content: s.slice(0, 2000) } }] });
const title = (s: string) => ({ title: [{ text: { content: s } }] });
function istDate(iso: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
