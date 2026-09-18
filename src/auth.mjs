// One-time OAuth: opens WHOOP consent, catches the redirect on localhost:8080, prints the refresh token.
import http from "node:http";
import { env } from "./env.mjs";

const CLIENT_ID = env("WHOOP_CLIENT_ID");
const CLIENT_SECRET = env("WHOOP_CLIENT_SECRET");
const REDIRECT = "http://localhost:8080/callback";
const SCOPES = "offline read:recovery read:sleep read:cycles read:workout read:profile";
const state = Math.random().toString(36).slice(2);

const url = new URL("https://api.prod.whoop.com/oauth/oauth2/auth");
url.search = new URLSearchParams({
  client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES, state,
}).toString();

console.log("\nOpen this in your browser and approve:\n\n" + url + "\n");

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
  if (u.searchParams.get("state") !== state) { res.writeHead(400).end("bad state"); return; }
  const code = u.searchParams.get("code");
  const r = await fetch("https://api.prod.whoop.com/oauth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT,
    }),
  });
  const j = await r.json();
  if (!j.refresh_token) { console.error(j); res.end("Failed — see terminal"); process.exit(1); }
  res.end("Done. You can close this tab.");
  console.log("\nWHOOP_REFRESH_TOKEN=" + j.refresh_token + "\n");
  console.log("Put that in .env for local runs AND in the GitHub repo secret WHOOP_REFRESH_TOKEN.");
  process.exit(0);
}).listen(8080, () => console.log("Listening on " + REDIRECT));
