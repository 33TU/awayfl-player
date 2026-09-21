import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const outdir = fileURLToPath(
  new URL(
    "../../../hono-proxy/static/game/gamefiles/pixi-benchmark/",
    import.meta.url,
  ),
);
// The worktree is a sibling of hono-proxy. Keep the regular player build untouched.
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ["main.mjs"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: outdir + "main.js",
  sourcemap: true,
  minify: false,
});
const hash = createHash("sha256")
  .update(await readFile(outdir + "main.js"))
  .digest("hex")
  .slice(0, 12);
const html = (await readFile("index.html", "utf8")).replace(
  "./main.js",
  "./main.js?v=" + hash,
);
await writeFile(outdir + "index.html", html);
console.log("Built " + outdir);
