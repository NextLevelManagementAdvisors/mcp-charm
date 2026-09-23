// MCP App: interactive manual diagram/figure viewer.
// Registers a model-visible tool (show_manual_diagrams) that returns the
// figures found on a LEMON Manuals page, plus the ui:// HTML resource that
// renders them as an inline, zoomable gallery in MCP-Apps-capable hosts
// (e.g. Claude). See https://modelcontextprotocol.io/extensions/apps/overview
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const RESOURCE_URI = "ui://lemon/diagram-viewer.html";
const HERE = dirname(fileURLToPath(import.meta.url));

export interface Figure {
  url: string;
  caption: string;
}

export interface DiagramAppDeps {
  // Reuse the host server's mirror-aware, origin-allowlisted fetch.
  fetchUrl: (target: string) => Promise<{ html: string; finalUrl: string }>;
  // Allowed image origins (the LEMON mirrors) for the iframe CSP.
  imageOrigins: string[];
  version: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2]);
}

// Pull every <img> off a manual page, absolutize the src against the page URL,
// and derive a human caption from alt/title or the file name.
export function extractFigures(html: string, baseUrl: string): Figure[] {
  const out: Figure[] = [];
  const seen = new Set<string>();
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const rawSrc = attr(tag, "src");
    if (!rawSrc) continue;
    let url: string;
    try {
      url = new URL(rawSrc, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    let caption = (attr(tag, "alt") || attr(tag, "title") || "").trim();
    if (!caption) {
      try {
        caption = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      } catch {
        caption = "";
      }
    }
    out.push({ url, caption });
  }
  return out;
}

// Lazily load + cache the bundled widget HTML produced by scripts/build-ui.mjs.
let cachedHtml: string | null = null;
function widgetHtml(): string {
  if (cachedHtml === null) {
    cachedHtml = readFileSync(join(HERE, "ui", "diagram-viewer.html"), "utf-8");
  }
  return cachedHtml;
}

export function registerDiagramApp(server: McpServer, deps: DiagramAppDeps): void {
  registerAppTool(
    server,
    "show_manual_diagrams",
    {
      title: "Show Manual Diagrams",
      description:
        "Display the diagrams/illustrations from a LEMON Manuals page as an interactive, zoomable gallery rendered inline in the conversation. Use this while explaining a repair so the user can see the figures referenced in the steps. Pass the URL of the manual page (same kind of URL get_manual_content takes). Returns the figure count and captions to the model; the images render in the widget.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(
            "Full URL of a LEMON Manuals page on an allowed lemon-manuals domain, e.g. https://lemon-manuals.la/Ford/2018/F-150%204WD%20V8-5.0L/Repair%20and%20Diagnosis/",
          ),
      },
      outputSchema: {
        source: z.string(),
        count: z.number(),
        figures: z.array(z.object({ url: z.string(), caption: z.string() })),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ url }) => {
      const { html, finalUrl } = await deps.fetchUrl(url);
      const figures = extractFigures(html, finalUrl);
      const summary =
        figures.length === 0
          ? "No diagrams/images found on this manual page."
          : `Found ${figures.length} diagram(s). Captions: ${figures
              .slice(0, 12)
              .map((f) => f.caption || "(untitled)")
              .join("; ")}${figures.length > 12 ? "; …" : ""}`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { source: finalUrl, count: figures.length, figures },
      };
    },
  );

  registerAppResource(
    server,
    "Manual Diagram Viewer",
    RESOURCE_URI,
    {
      description: "Interactive zoomable gallery of LEMON manual diagrams.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml(),
          _meta: {
            // Allow the sandboxed iframe to load manual images from the mirrors.
            ui: { csp: { resourceDomains: deps.imageOrigins } },
          },
        },
      ],
    }),
  );
}
