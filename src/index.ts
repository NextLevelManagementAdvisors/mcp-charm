#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { registerDiagramApp } from "./diagram-app.js";
import { registerSkills } from "./skill-registry.js";
import {
  decodeEntities,
  pathSegments,
  encodePath,
  extractLinks as extractLinksPure,
  computeBrowseEntries,
  type LinkEntry,
} from "./browse-links.js";

const VERSION = "0.5.0";
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

function extractLinks(html: string, baseUrl: string): LinkEntry[] {
  return extractLinksPure(html, baseUrl, ALLOWED_ORIGINS);
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

async function fetchDirResilient(
  path: string
): Promise<{ html: string; finalUrl: string; fetchedSegs: string[] }> {
  const segs = pathSegments(path);
  try {
    const { html, finalUrl } = await fetchDir(path);
    return { html, finalUrl, fetchedSegs: segs };
  } catch (err) {
    // Some LEMON templates nest real content under plain-text category
    // headers with no page of their own (#22). A path built from one of
    // those synthetic headers won't resolve directly — walk up to the
    // nearest real ancestor page and let the caller re-filter its links
    // against the full requested path instead.
    for (let pop = 1; pop < segs.length; pop++) {
      const ancestorSegs = segs.slice(0, segs.length - pop);
      try {
        const { html, finalUrl } = await fetchDir(ancestorSegs.join("/"));
        return { html, finalUrl, fetchedSegs: ancestorSegs };
      } catch {
        // try a shallower ancestor
      }
    }
    throw err;
  }
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
  s = s.replace(/<a\s+[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
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

interface LaborTimeRow {
  component: string;
  operation: string;
  applies_to: string;
  time_hours: number | null;
  warranty_hours: number | null;
  skill_level: string;
  notes: string;
}

const isDecimal = (s: string): boolean => /^\d+(\.\d+)?$/.test(s);

function stripLaborCell(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, "; ").replace(/<[^>]+>/g, "")).trim();
}

// Labor Times leaf pages hold a title ("Component: Operation"), an optional
// intro, and a table of hour rows. Rows can be interrupted by full-width
// "Combination Procedure" separators that introduce a related component/
// operation bundled onto the same page (e.g. a brake-hose bleed procedure
// listed on the brake-pad R&R page) — track the active label as we walk rows.
function parseLaborLeaf(html: string): LaborTimeRow[] {
  const h1Match = html.match(/<h1>([\s\S]*?)<\/h1>/i);
  const h1Text = h1Match ? decodeEntities(h1Match[1].replace(/<[^>]+>/g, "")).trim() : "";
  const sepIdx = h1Text.indexOf(": ");
  const pageComponent = sepIdx >= 0 ? h1Text.slice(0, sepIdx).trim() : h1Text;
  const pageOperation = sepIdx >= 0 ? h1Text.slice(sepIdx + 2).trim() : "";

  const tableMatch = html.match(/<table>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const tbodyMatch = tableMatch[1].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const trs = (tbodyMatch ? tbodyMatch[1] : "").match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];

  const rows: LaborTimeRow[] = [];
  let curComponent = pageComponent;
  let curOperation = pageOperation;
  let curGroupNote = "";

  for (const tr of trs) {
    const comboMatch = tr.match(/<td[^>]*\bcolspan=[^>]*>([\s\S]*?)<\/td>/i);
    if (comboMatch) {
      const cellHtml = comboMatch[1];
      const labelMatch = cellHtml.match(/Combination Procedure:<\/b>\s*([^<]*)/i);
      const label = labelMatch ? decodeEntities(labelMatch[1]).trim().replace(/:$/, "") : "";
      curGroupNote = stripLaborCell(cellHtml.split(/<br\s*\/?>/i).slice(1).join(" "));
      if (label) {
        const idx = label.indexOf(": ");
        if (idx >= 0) {
          curComponent = label.slice(0, idx).trim();
          curOperation = label.slice(idx + 2).trim();
        } else {
          curOperation = label;
        }
      }
      continue;
    }
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripLaborCell(m[1]));
    if (cells.length < 5) continue;
    const [appliesTo, note, stdHours, warHours, skill] = cells;
    const noteParts = [curGroupNote, note].filter(Boolean);
    if (stdHours && !isDecimal(stdHours)) noteParts.push(`standard hours: ${stdHours}`);
    rows.push({
      component: curComponent,
      operation: curOperation,
      applies_to: appliesTo,
      time_hours: isDecimal(stdHours) ? parseFloat(stdHours) : null,
      warranty_hours: isDecimal(warHours) ? parseFloat(warHours) : null,
      skill_level: skill,
      notes: noteParts.join("; "),
    });
  }
  return rows;
}

// A model's own Labor Times page sometimes has no data and instead points to
// an "Other Variant" (a mechanically-identical trim) that carries the real
// table. Follow that redirect transparently and report the substitution.
async function resolveLaborTimesTree(
  basePath: string
): Promise<{ html: string; finalUrl: string; sourceVariant?: string }> {
  const { html, finalUrl } = await fetchDir(`${basePath}/Labor Times`);
  if (!/only available for a different vehicle variant/i.test(html)) {
    return { html, finalUrl };
  }
  const otherVariant = extractLinks(html, finalUrl).find(
    (l) => l.segments[l.segments.length - 1]?.toLowerCase() === "other variant"
  );
  if (!otherVariant) return { html, finalUrl };
  const variantMatch = html.match(/Variant with labor times:<\/b>\s*([^<]+)/i);
  const { html: vh, finalUrl: vu } = await fetchUrl(otherVariant.url);
  return {
    html: vh,
    finalUrl: vu,
    sourceVariant: variantMatch ? decodeEntities(variantMatch[1]).trim() : undefined,
  };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "lemon-mcp",
    version: VERSION,
  });

  registerDiagramApp(server, { fetchUrl, imageOrigins: ALLOWED_ORIGINS, version: VERSION });
  registerSkills(server);
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
      const parentSegs = pathSegments(path);
      const { html, finalUrl, fetchedSegs } = await fetchDirResilient(path);
      const links = extractLinks(html, finalUrl);
      const isDownload = (l: LinkEntry) =>
        /\.zip$/i.test(l.pathname) || /^\/bundle\//i.test(l.pathname);
      const entries = computeBrowseEntries(parentSegs, links);
      const downloads = links
        .filter(isDownload)
        .map((l) => ({ name: l.text, url: l.url, type: "download" }));

      const syntheticCount = entries.filter((e) => e.synthetic).length;
      const usedAncestor = fetchedSegs.length !== parentSegs.length;
      const note = syntheticCount > 0
        ? `${syntheticCount} ${syntheticCount === 1 ? "entry is" : "entries are"} a category label with no page of its own — its content is nested deeper. Call browse_manuals again with that entry's "path" to keep drilling down, or use get_manual_content on "${finalUrl}" to see the whole subtree at once.`
        : usedAncestor
          ? `"${path}" has no page of its own; showing categories nested under "${fetchedSegs.join("/")}".`
          : undefined;

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
                note,
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

  // Tool 6: lookup_labor_time
  server.registerTool(
    "lookup_labor_time",
    {
      description:
        'Look up structured labor times (standard/warranty hours, skill level) for a component on a specific vehicle, without manually navigating the Labor Times tree. Searches the whole Labor Times subtree for leaf pages whose component name contains the given keyword (case-insensitive substring match), optionally narrowed by an operation keyword (e.g. "Remove & Replace", "Diagnosis", "Testing"). If labor times for the exact requested trim are only published under a related variant, that substitute is used automatically and reported in the result as "variant_used".',
      inputSchema: {
        make: z.string().min(1).describe('Vehicle make, e.g. "Ford".'),
        year: z.string().min(1).describe('Model year, e.g. "2011".'),
        model: z
          .string()
          .min(1)
          .describe(
            'Exact model/trim path segment as returned by browse_manuals or search_manuals, e.g. "E450 Super Duty 6.8 S, Gas".'
          ),
        component: z
          .string()
          .min(1)
          .describe('Component keyword, matched case-insensitively as a substring, e.g. "HVAC Door Actuator" or "Brake Pad".'),
        operation: z
          .string()
          .optional()
          .describe('Optional operation keyword filter, e.g. "Remove & Replace", "Diagnosis", "Testing".'),
      },
    },
    async ({ make, year, model, component, operation }) => {
      const basePath = [make, year, model].join("/");
      const { html, finalUrl, sourceVariant } = await resolveLaborTimesTree(basePath);

      const treeBaseSegs = pathSegments(new URL(finalUrl).pathname);
      const componentNorm = component.trim().toLowerCase();
      const operationNorm = operation?.trim().toLowerCase();

      const leafLinks = extractLinks(html, finalUrl).filter((l) => {
        if (l.segments.length < treeBaseSegs.length + 2) return false;
        if (!treeBaseSegs.every((seg, i) => l.segments[i].toLowerCase() === seg.toLowerCase())) return false;
        const componentSeg = l.segments[l.segments.length - 2];
        const operationSeg = l.segments[l.segments.length - 1];
        if (!componentSeg.toLowerCase().includes(componentNorm)) return false;
        if (operationNorm && !operationSeg.toLowerCase().includes(operationNorm)) return false;
        return true;
      });

      const MAX_LEAVES = 30;
      const truncated = leafLinks.length > MAX_LEAVES;
      const targets = leafLinks.slice(0, MAX_LEAVES);

      const pages = await Promise.all(
        targets.map(async (l) => {
          try {
            const { html: leafHtml } = await fetchUrl(l.url);
            return { link: l, rows: parseLaborLeaf(leafHtml) };
          } catch {
            return null;
          }
        })
      );

      const results = pages
        .filter((p): p is { link: LinkEntry; rows: LaborTimeRow[] } => p !== null)
        .flatMap((p) =>
          p.rows
            .filter((row) => !operationNorm || row.operation.toLowerCase().includes(operationNorm))
            .map((row) => ({
              ...row,
              source_variant: sourceVariant,
              path: p.link.segments.join("/"),
            }))
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                year,
                model,
                component,
                operation: operation ?? null,
                variant_used: sourceVariant ?? model,
                results,
                count: results.length,
                truncated,
                note:
                  results.length === 0
                    ? `No labor time entries found for "${component}"${operation ? ` / "${operation}"` : ""}. Try a broader keyword, or use browse_manuals with path "${basePath}/Labor Times" to explore the tree.`
                    : truncated
                      ? `Component keyword matched more than ${MAX_LEAVES} pages; only the first ${MAX_LEAVES} were fetched. Narrow the component or operation keyword for full coverage.`
                      : undefined,
              },
              null,
              2
            ),
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
        res
          .status(401)
          .set("WWW-Authenticate", 'Bearer realm="mcp-charm", error="invalid_token"')
          .json({ error: "unauthorized" });
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
