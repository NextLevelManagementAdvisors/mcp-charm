// Bundles the diagram-viewer widget into a single self-contained HTML file
// (JS inlined) so it can be served as one ui:// MCP App resource with no
// external script/style origins to whitelist in CSP.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const { version } = JSON.parse(await readFile(join(repo, "package.json"), "utf-8"));

const result = await build({
  entryPoints: [join(repo, "ui", "diagram-viewer.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
});
const js = result.outputFiles[0].text;

let html = await readFile(join(repo, "ui", "diagram-viewer.html"), "utf-8");
html = html.replace("</body>", `<script type="module">\n${js}\n</script>\n</body>`);

await mkdir(join(repo, "dist", "ui"), { recursive: true });
await writeFile(join(repo, "dist", "ui", "diagram-viewer.html"), html);
console.log(`Built dist/ui/diagram-viewer.html (${html.length} bytes)`);
