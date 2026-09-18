// Tiny .env loader so local runs work without dotenv. GitHub Actions injects env directly.
import { readFileSync, existsSync } from "node:fs";
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
export const env = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env ${k}`);
  return v;
};
