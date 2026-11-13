// Construit dist/gophish-worker.js : un seul fichier contenant le Worker et
// toutes les pages de public/, à coller dans Cloudflare > Edit code.
// Usage : npm run build:single
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const map = {};
for (const f of readdirSync("public")) {
  const type = TYPES[extname(f)];
  if (!type) continue;
  map["/" + f] = { type, body: readFileSync(join("public", f), "utf8") };
}
writeFileSync("src/assets.generated.js", "export const ASSETS_MAP = " + JSON.stringify(map) + ";\n");

mkdirSync("dist", { recursive: true });
execFileSync("node_modules/.bin/esbuild", [
  "src/single.js", "--bundle", "--format=esm", "--platform=neutral",
  "--outfile=dist/gophish-worker.js",
], { stdio: "inherit" });
console.log("OK : dist/gophish-worker.js");
