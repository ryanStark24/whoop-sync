const API = "https://api.notion.com/v1";

export class Notion {
  constructor(token, dbId) {
    this.dbId = dbId.replace(/-/g, "");
    this.h = { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
  }

  async req(method, path, body) {
    let r = await fetch(API + path, { method, headers: this.h, body: body ? JSON.stringify(body) : undefined });
    // Notion allows about three requests a second; a long backfill can brush against that.
    for (let attempt = 0; r.status === 429 && attempt < 5; attempt++) {
      await new Promise((ok) => setTimeout(ok, (Number(r.headers.get("retry-after")) || 2) * 1000));
      r = await fetch(API + path, { method, headers: this.h, body: body ? JSON.stringify(body) : undefined });
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }

  async findByDate(isoDate) {
    const j = await this.req("POST", `/databases/${this.dbId}/query`, {
      filter: { property: "Date", date: { equals: isoDate } }, page_size: 1,
    });
    return j.results?.[0]?.id ?? null;
  }

  async upsert(isoDate, props) {
    const id = await this.findByDate(isoDate);
    if (id) return this.req("PATCH", `/pages/${id}`, { properties: props }).then(() => "updated");
    await this.req("POST", "/pages", { parent: { database_id: this.dbId }, properties: props });
    return "created";
  }
}

// Property builders
export const P = {
  title: (s) => ({ title: [{ text: { content: String(s).slice(0, 200) } }] }),
  num:   (n) => (n == null || Number.isNaN(n) ? { number: null } : { number: Math.round(n * 100) / 100 }),
  date:  (d) => ({ date: { start: d } }),
  text:  (s) => ({ rich_text: [{ text: { content: String(s ?? "").slice(0, 2000) } }] }),
  sel:   (s) => (s ? { select: { name: s } } : { select: null }),
};
