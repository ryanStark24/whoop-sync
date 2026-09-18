// Pull the last N days from WHOOP and upsert one row per day into Notion.
import { appendFileSync } from "node:fs";
import { env } from "./env.mjs";
import { refresh, Whoop } from "./whoop.mjs";
import { Notion, P } from "./notion.mjs";

const TZ = "Asia/Kolkata";
const DAYS = Number(env("DAYS_BACK", "3"));

const localDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
const hrs = (ms) => (ms == null ? null : ms / 3_600_000);
const zone = (rec) => (rec == null ? null : rec >= 67 ? "Green" : rec >= 34 ? "Yellow" : "Red");

async function main() {
  // 1. Tokens (and hand the rotated refresh token back to the workflow)
  const t = await refresh(env("WHOOP_CLIENT_ID"), env("WHOOP_CLIENT_SECRET"), env("WHOOP_REFRESH_TOKEN"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `refresh_token=${t.refreshToken}\n`);
  else console.log("New WHOOP_REFRESH_TOKEN (save it!):", t.refreshToken);

  const whoop = new Whoop(t.accessToken);
  const notion = new Notion(env("NOTION_TOKEN"), env("NOTION_DB_ID"));

  const end = new Date();
  const start = new Date(end.getTime() - (DAYS + 1) * 86_400_000);
  const cycles = await whoop.cycles(start.toISOString(), end.toISOString());
  const workouts = await whoop.workouts(start.toISOString(), end.toISOString());

  const workoutsByDay = {};
  for (const w of workouts) {
    const d = localDate(w.start);
    const mins = Math.round((new Date(w.end) - new Date(w.start)) / 60_000);
    (workoutsByDay[d] ??= []).push(`${w.sport_name ?? "Workout"} ${mins}m · strain ${w.score?.strain?.toFixed(1) ?? "?"}`);
  }

  for (const c of cycles) {
    const day = localDate(c.start);
    const [rec, slp] = await Promise.all([whoop.cycleRecovery(c.id), whoop.cycleSleep(c.id)]);
    const rs = rec?.score ?? {}, ss = slp?.score ?? {}, st = ss.stage_summary ?? {};
    const asleep = st.total_in_bed_time_milli != null ? st.total_in_bed_time_milli - (st.total_awake_time_milli ?? 0) : null;

    const props = {
      "Name": P.title(day),
      "Date": P.date(day),
      "Cycle ID": P.text(c.id),
      "Recovery %": P.num(rs.recovery_score),
      "Recovery Zone": P.sel(zone(rs.recovery_score)),
      "HRV ms": P.num(rs.hrv_rmssd_milli),
      "RHR": P.num(rs.resting_heart_rate),
      "SpO2 %": P.num(rs.spo2_percentage),
      "Skin Temp C": P.num(rs.skin_temp_celsius),
      "Sleep Hours": P.num(hrs(asleep)),
      "Sleep Performance %": P.num(ss.sleep_performance_percentage),
      "Sleep Efficiency %": P.num(ss.sleep_efficiency_percentage),
      "Sleep Consistency %": P.num(ss.sleep_consistency_percentage),
      "Sleep Need Hours": P.num(hrs(ss.sleep_needed?.baseline_milli)),
      "REM Hours": P.num(hrs(st.total_rem_sleep_time_milli)),
      "Deep Hours": P.num(hrs(st.total_slow_wave_sleep_time_milli)),
      "Strain": P.num(c.score?.strain),
      "Calories": P.num(c.score?.kilojoule != null ? c.score.kilojoule / 4.184 : null),
      "Avg HR": P.num(c.score?.average_heart_rate),
      "Max HR": P.num(c.score?.max_heart_rate),
      "Workouts": P.text((workoutsByDay[day] ?? []).join("\n")),
    };
    const what = await notion.upsert(day, props);
    console.log(`${day}: ${what} — recovery ${rs.recovery_score ?? "-"}%, strain ${c.score?.strain?.toFixed(1) ?? "-"}, sleep ${hrs(asleep)?.toFixed(1) ?? "-"}h`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
