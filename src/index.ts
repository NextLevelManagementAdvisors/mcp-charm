#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const VERSION = "0.2.2";
const UA = `lemon-mcp/${VERSION} (https://github.com/NextLevelManagementAdvisors/mcp-charm)`;

// LEMON mirrors, in failover order. Override with LEMON_BASE_URLS (comma-separated).
const BASES: string[] = (
  process.env.LEMON_BASE_URLS ??
  "https://lemon-manuals.la,https://lemon-manuals.org.ua,https://lemon-manuals.gy"
)
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const ALLOWED_ORIGINS = BASES.map((b) => new URL(b).origin);
const PRIMARY = BASES[0];

// Non-content pages to skip when extracting links.
const SKIP_PATHS = new Set([
  "",
  "nfo.html",
  "about.html",
  "bittorrent.html",
  "index.html",
  "lemon-manuals.torrent",
]);

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

function pathSegments(path: string): string[] {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

function encodePath(path: string): string {
  return pathSegments(path)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

// Case/hyphen/space-insensitive matching: "F-150" matches "F 150" and "f150".
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[-\s]+/g, "");
}

async function fetchUrl(target: string): Promise<{ html: string; finalUrl: string }> {
  const u = new URL(target);
  if (!ALLOWED_ORIGINS.includes(u.origin)) {
    throw new Error(`URL origin must be one of: ${ALLOWED_ORIGINS.join(", ")} — got ${u.origin}`);
  }
  const ordered = [u.origin, ...ALLOWED_ORIGINS.filter((o) => o !== u.origin)];
  let lastErr: unknown;
  for (const origin of ordered) {
    const candidate = origin + u.pathname + u.search;
    try {
      const res = await fetch(candidate, {
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${candidate}`);
      return { html: await res.text(), finalUrl: candidate };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`All mirrors failed for ${u.pathname}: ${String(lastErr)}`);
}

async function fetchDir(path: string): Promise<{ html: string; finalUrl: string }> {
  const encoded = encodePath(path);
  const target = encoded.length ? `${PRIMARY}/${encoded}/` : `${PRIMARY}/`;
  return fetchUrl(target);
}

interface LinkEntry {
  text: string;
  url: string;
  pathname: string;
  segments: string[];
}

function extractLinks(html: string, baseUrl: string): LinkEntry[] {
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const out: LinkEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = decodeEntities(m[1].trim());
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "").trim());
    if (!text || rawHref.startsWith("javascript:") || rawHref.startsWith("#")) continue;
    let u: URL;
    try {
      u = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (!ALLOWED_ORIGINS.includes(u.origin)) continue;
    const pathname = u.pathname.replace(/\/+$/, "");
    const tail = pathname.replace(/^\/+/, "");
    if (SKIP_PATHS.has(tail.toLowerCase())) continue;
    const key = pathname; // dedupe across mirrors by path
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text,
      url: u.toString(),
      pathname,
      segments: pathSegments(pathname),
    });
  }
  return out;
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (_m, src) => {
    try {
      return `![image](${new URL(decodeEntities(String(src)), baseUrl).toString()})`;
    } catch {
      return "";
    }
  });
  s = s.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const t = decodeEntities(String(text).replace(/<[^>]+>/g, "").trim());
    try {
      const u = new URL(decodeEntities(String(href)), baseUrl);
      if (u.protocol === "javascript:") return t;
      return `[${t}](${u.toString()})`;
    } catch {
      return t;
    }
  });
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<t[dh][^>]*>/gi, " | ");
  s = s.replace(/<\/(p|div|ul|ol|table|tr)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "lemon-mcp",
    version: VERSION,
  });

  // Tool 1: list_makes
  server.registerTool(
    "list_makes",
    {
      description:
        "List all vehicle makes available on LEMON Manuals (free service/workshop manuals, model years 1960-2025, US & Canada market, includes classic Operation CHARM data). Returns make names like Acura, BMW, Ford, Tesla, Toyota.",
      inputSchema: {},
    },
    async () => {
      const { html, finalUrl } = await fetchDir("");
      const links = extractLinks(html, finalUrl);
      const makes = links
        .filter((l) => l.segments.length === 1)
        .map((l) => ({ name: l.segments[0], url: l.url }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { makes: makes.map((m) => m.name), count: makes.length, details: makes },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 2: browse_make
  server.registerTool(
    "browse_make",
    {
      description:
        "Browse available model years for a given make on LEMON Manuals. For example, browse_make('Ford') returns all years (1960-2025) for which Ford manuals exist. Use browse_manuals with a 'Make/Year' path to see models for that year.",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe('Vehicle make name, e.g. "Ford", "BMW", "Toyota". Use list_makes to see all available makes.'),
      },
    },
    async ({ make }) => {
      const { html, finalUrl } = await fetchDir(make);
      const links = extractLinks(html, finalUrl);
      const makeLower = make.trim().toLowerCase();
      const entries = links
        .filter(
          (l) =>
            l.segments.length === 2 &&
            l.segments[0].toLowerCase() === makeLower
        )
        .map((l) => ({
          label: l.segments[1],
          url: l.url,
          path: l.segments.join("/"),
        }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                url: finalUrl,
                entries,
                count: entries.length,
                note: `Use browse_manuals with path like "${make}/2018" to see models for a specific year.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 3: browse_manuals
  server.registerTool(
    "browse_manuals",
    {
      description:
        'Browse manuals at a specific path on LEMON Manuals. Use paths like "Ford/2018" to see model+engine combos, or "Ford/2018/F-150 4WD V8-5.0L" to see manual sections (Repair and Diagnosis, Parts and Labor, TSBs, zip download). Note: LEMON year pages nest models under folder headers; entry names here are derived from the full URL path, which is authoritative.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Path within the site, e.g. "Ford/2018", "Toyota/2005". No leading/trailing slashes.'),
      },
    },
    async ({ path }) => {
      const { html, finalUrl } = await fetchDir(path);
      const links = extractLinks(html, finalUrl);
      const parentSegs = pathSegments(path);
      const isChild = (l: LinkEntry) =>
        l.segments.length === parentSegs.length + 1 &&
        parentSegs.every((seg, i) => l.segments[i].toLowerCase() === seg.toLowerCase());
      const entries = links
        .filter((l) => isChild(l) && !/\.zip$/i.test(l.pathname))
        .map((l) => ({
          name: l.segments[l.segments.length - 1],
          url: l.url,
          path: l.segments.join("/"),
          type: "directory",
        }));
      const downloads = links
        .filter((l) => /\.zip$/i.test(l.pathname))
        .map((l) => ({ name: l.text, url: l.url, type: "download" }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path,
                url: finalUrl,
                entries: [...entries, ...downloads],
                count: entries.length + downloads.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 4: search_manuals
  server.registerTool(
    "search_manuals",
    {
      description:
        "Search for service manuals by vehicle make and optional keyword. If the query includes a 4-digit year (e.g. '2018'), only that year is searched. Otherwise the 5 most recent available years are searched. Matching ignores case, hyphens, and spaces, so 'F-150', 'F 150', and 'f150' are equivalent. Returns matching model/manual entries with URLs.",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe('Vehicle make to search within, e.g. "Ford", "Toyota". Use list_makes to see all available makes.'),
        query: z
          .string()
          .optional()
          .describe('Optional search keyword. Can be a year ("2018"), model ("F-150"), engine ("V8"), or combo ("2018 F-150").'),
      },
    },
    async ({ make, query }) => {
      const { html, finalUrl } = await fetchDir(make);
      const makeLower = make.trim().toLowerCase();
      const yearEntries = extractLinks(html, finalUrl).filter(
        (l) => l.segments.length === 2 && l.segments[0].toLowerCase() === makeLower
      );

      if (yearEntries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { make, query, results: [], note: "No years found for this make." },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!query) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  make,
                  query: null,
                  results: yearEntries.map((e) => ({
                    label: e.segments[1],
                    url: e.url,
                    path: e.segments.join("/"),
                  })),
                  count: yearEntries.length,
                  note: `Showing available years for ${make}. Provide a query with a year or model name to search for specific manuals.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      let yearsToSearch: typeof yearEntries;
      const yearMatch = query.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) {
        const targetYear = yearMatch[0];
        yearsToSearch = yearEntries.filter((e) => e.segments[1] === targetYear);
        if (yearsToSearch.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    make,
                    query,
                    results: [],
                    note: `Year ${targetYear} not found for ${make}. Available years: ${yearEntries.map((e) => e.segments[1]).join(", ")}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } else {
        yearsToSearch = yearEntries.slice(-5);
      }

      const keyword = query.replace(/\b(19|20)\d{2}\b/, "").trim();
      const keywordNorm = normalizeForMatch(keyword);
      const results: Array<{ make: string; year: string; model: string; url: string; path: string }> = [];

      await Promise.all(
        yearsToSearch.map(async (yearEntry) => {
          try {
            const year = yearEntry.segments[1];
            const { html: yh, finalUrl: yu } = await fetchDir(yearEntry.segments.join("/"));
            const modelEntries = extractLinks(yh, yu).filter(
              (l) =>
                l.segments.length === 3 &&
                l.segments[0].toLowerCase() === makeLower &&
                l.segments[1] === year
            );
            for (const entry of modelEntries) {
              const model = entry.segments[2];
              if (!keywordNorm || normalizeForMatch(model).includes(keywordNorm)) {
                results.push({
                  make,
                  year,
                  model,
                  url: entry.url,
                  path: entry.segments.join("/"),
                });
              }
            }
          } catch {
            // skip years that fail
          }
        })
      );

      results.sort((a, b) => {
        const yearDiff = parseInt(b.year) - parseInt(a.year);
        if (yearDiff !== 0) return yearDiff;
        return a.model.localeCompare(b.model);
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                query,
                results,
                count: results.length,
                note: results.length === 0 ? `No manuals found matching "${query}" for ${make}.` : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 5: get_manual_content
  server.registerTool(
    "get_manual_content",
    {
      description:
        "Fetch the content of a specific LEMON Manuals page as markdown, including procedure text, image links, and links to manual sections and zip downloads. URL must be on a lemon-manuals domain.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("Full URL of a LEMON Manuals page, e.g. https://lemon-manuals.la/Ford/2018/F-150%204WD%20V8-5.0L/. Must be on an allowed lemon-manuals domain."),
      },
    },
    async ({ url }) => {
      const { html, finalUrl } = await fetchUrl(url);
      return {
        content: [
          {
            type: "text",
            text: htmlToMarkdown(html, finalUrl),
          },
        ],
      };
    }
  );

  return server;
}

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttp() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  const token = process.env.MCP_AUTH_TOKEN;

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "lemon-mcp", version: VERSION, mirrors: BASES });
  });

  app.all("/mcp", async (req, res) => {
    if (token) {
      const auth = req.headers.authorization ?? "";
      const qpRaw = req.query.token;
      const qp = Array.isArray(qpRaw) ? qpRaw[0] : qpRaw;
      const headerOk = auth === `Bearer ${token}`;
      const queryOk = typeof qp === "string" && qp === token;
      if (!headerOk && !queryOk) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: String(err) });
      }
    }
  });

  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, "0.0.0.0", () => {
    console.error(`lemon-mcp ${VERSION} HTTP listening on :${port} (mirrors: ${BASES.join(", ")})`);
  });
}

const mode = process.argv[2] ?? process.env.MCP_TRANSPORT ?? "stdio";
const entry = mode === "http" ? runHttp() : runStdio();
entry.catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
