#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
import { parseLaborLeaf, type LaborTimeRow } from "./labor-parser.js";
import { createResilientFetcher, fetchDirResilient as fetchDirResilientCore } from "./resilient-fetch.js";
import {
  findWrapperImageUrls,
  substituteImageUrls,
  extractImageSrc,
  parseDtcTableHtml,
  tokenizeSymptom,
  scoreText,
  relevanceScore,
  extractSnippet,
} from "./diagnosis.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION: string = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf-8")).version;
const UA = `lemon-mcp/${VERSION} (https://github.com/NextLevelManagementAdvisors/mcp-charm)`;

// LEMON mirrors, in failover order. Override with LEMON_BASE_URLS (comma-separated).
// lemon-manuals.la/.org.ua/.gy all share one host (AS6698); lemon.dogeware.me is an
// independent third-party mirror and goes first so a dead host doesn't break fresh deploys.
const BASES: string[] = (
  process.env.LEMON_BASE_URLS ??
  "https://lemon.dogeware.me,https://lemon-manuals.la,https://lemon-manuals.org.ua,https://lemon-manuals.gy"
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

const { fetchUrl } = createResilientFetcher(ALLOWED_ORIGINS, UA);

async function fetchDir(path: string): Promise<{ html: string; finalUrl: string }> {
  const encoded = encodePath(path);
  const target = encoded.length ? `${PRIMARY}/${encoded}/` : `${PRIMARY}/`;
  return fetchUrl(target);
}

async function fetchDirResilient(
  path: string
): Promise<{ html: string; finalUrl: string; fetchedSegs: string[] }> {
  return fetchDirResilientCore(fetchDir, path, pathSegments);
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<img[^>]*?src=(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_m, src1, src2) => {
    const src = src1 ?? src2;
    try {
      return `![image](${new URL(decodeEntities(String(src)), baseUrl).toString()})`;
    } catch {
      return "";
    }
  });
  s = s.replace(
    /<a\s+[^>]*?href=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, h1, h2, h3, text) => {
      const href = h1 ?? h2 ?? h3;
      const t = decodeEntities(String(text).replace(/<[^>]+>/g, "").trim());
      try {
        const u = new URL(decodeEntities(String(href)), baseUrl);
        if (u.protocol === "javascript:") return t;
        return `[${t}](${u.toString()})`;
      } catch {
        return t;
      }
    }
  );
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

// Links exactly one path segment deeper than `parentSegs`, whose leading
// segments match — i.e. the direct children of that directory node.
function directChildren(links: LinkEntry[], parentSegs: string[]): LinkEntry[] {
  return links.filter(
    (l) =>
      l.segments.length === parentSegs.length + 1 &&
      parentSegs.every((seg, i) => l.segments[i]?.toLowerCase() === seg.toLowerCase())
  );
}

// Every link nested below `parentSegs` at any depth. LEMON directory pages
// render the whole subtree of anchors, so descendants of a section index are
// usually all present on that one page (this is what browse_manuals' synthetic
// categories rely on, #22).
function descendantLinks(links: LinkEntry[], parentSegs: string[]): LinkEntry[] {
  return links.filter(
    (l) =>
      l.segments.length > parentSegs.length &&
      parentSegs.every((seg, i) => l.segments[i]?.toLowerCase() === seg.toLowerCase())
  );
}

// Resolve a make/year + model keyword to the model's directory entry. The
// keyword is matched case/hyphen/space-insensitively against the model path
// segment, so "E450" matches "E450 Super Duty 6.8 S, Gas".
async function locateModel(
  make: string,
  year: string,
  modelKeyword: string
): Promise<{ modelEntry: LinkEntry | null; available: string[] }> {
  const { html, finalUrl } = await fetchDir(`${make}/${year}`);
  const makeLower = make.trim().toLowerCase();
  const modelLinks = extractLinks(html, finalUrl).filter(
    (l) =>
      l.segments.length === 3 &&
      l.segments[0].toLowerCase() === makeLower &&
      l.segments[1] === year
  );
  const kw = normalizeForMatch(modelKeyword);
  const modelEntry = modelLinks.find((l) => normalizeForMatch(l.segments[2]).includes(kw)) ?? null;
  return { modelEntry, available: modelLinks.map((l) => l.segments[2]) };
}

// Find the "Repair and Diagnosis" section on a model page (LEMON labels it
// "Repair and Diagnosis"; older CHARM data used "Repair & Diagnosis" — match
// both by looking for repair + diagnos in the segment name).
async function locateRepairDiagnosis(modelEntry: LinkEntry): Promise<LinkEntry | null> {
  const { html, finalUrl } = await fetchUrl(modelEntry.url);
  const links = extractLinks(html, finalUrl);
  return (
    links.find((l) => {
      const last = l.segments[l.segments.length - 1]?.toLowerCase() ?? "";
      return last.includes("repair") && last.includes("diagnos");
    }) ?? null
  );
}

// Image references on LEMON manual pages point at HTML wrapper pages
// (e.g. /images25/VA344587/) rather than direct .png/.jpg files. Fetch the
// wrapper and pull out the real <img src> so vision models and clients can
// render diagrams inline (#7/#8). Falls back to the wrapper URL on any error.
async function resolveImageUrl(wrapperUrl: string): Promise<string> {
  try {
    const { html, finalUrl } = await fetchUrl(wrapperUrl);
    return extractImageSrc(html, finalUrl) ?? wrapperUrl;
  } catch {
    return wrapperUrl;
  }
}

async function resolveMarkdownImageUrls(markdown: string): Promise<string> {
  const wrappers = findWrapperImageUrls(markdown);
  if (wrappers.length === 0) return markdown;
  const resolved = new Map<string, string>();
  await Promise.all(
    wrappers.map(async (url) => {
      resolved.set(url, await resolveImageUrl(url));
    })
  );
  return substituteImageUrls(markdown, resolved);
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
        "Search for service manuals by vehicle make and optional keyword. When 'year' is provided, only that year is searched. When 'year' is omitted, ALL available years are searched by default. Set 'recent_only' to true to limit the search to the 5 most recent years instead (ignored when a specific year is given). Matching ignores case, hyphens, and spaces, so 'F-150', 'F 150', and 'f150' are equivalent. Returns matching model/manual entries with URLs.",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe('Vehicle make to search within, e.g. "Ford", "Toyota". Use list_makes to see all available makes.'),
        keyword: z
          .string()
          .optional()
          .describe('Optional keyword to filter models, e.g. "F-150", "V8", "Auxiliary Heater". When omitted (and no year given), returns the list of available years for the make.'),
        year: z
          .string()
          .optional()
          .describe('Optional 4-digit model year to scope the search, e.g. "2011". When provided, only that year is searched; when omitted, all years are searched (unless recent_only is true).'),
        recent_only: z
          .boolean()
          .optional()
          .describe('When true, limit the search to the 5 most recent years for the make instead of searching all years. Defaults to false. Ignored when a specific year is provided.'),
      },
    },
    async ({ make, keyword, year, recent_only }) => {
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
                { make, keyword: keyword ?? null, year: year ?? null, results: [], note: "No years found for this make." },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!keyword && !year) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  make,
                  keyword: null,
                  year: null,
                  results: yearEntries.map((e) => ({
                    label: e.segments[1],
                    url: e.url,
                    path: e.segments.join("/"),
                  })),
                  count: yearEntries.length,
                  note: `Showing available years for ${make}. Provide a keyword or year to search for specific manuals.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      let yearsToSearch: typeof yearEntries;
      if (year) {
        yearsToSearch = yearEntries.filter((e) => e.segments[1] === year);
        if (yearsToSearch.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    make,
                    keyword: keyword ?? null,
                    year,
                    results: [],
                    note: `Year ${year} not found for ${make}. Available years: ${yearEntries.map((e) => e.segments[1]).join(", ")}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } else if (recent_only) {
        yearsToSearch = [...yearEntries]
          .sort((a, b) => parseInt(a.segments[1], 10) - parseInt(b.segments[1], 10))
          .slice(-5);
      } else {
        yearsToSearch = yearEntries;
      }

      const keywordNorm = normalizeForMatch((keyword ?? "").trim());
      const results: Array<{ make: string; year: string; model: string; url: string; path: string }> = [];
      let failedPages = 0;

      await Promise.all(
        yearsToSearch.map(async (yearEntry) => {
          try {
            const entryYear = yearEntry.segments[1];
            const { html: yh, finalUrl: yu } = await fetchDir(yearEntry.segments.join("/"));
            const modelEntries = extractLinks(yh, yu).filter(
              (l) =>
                l.segments.length === 3 &&
                l.segments[0].toLowerCase() === makeLower &&
                l.segments[1] === entryYear
            );
            for (const entry of modelEntries) {
              const model = entry.segments[2];
              if (!keywordNorm || normalizeForMatch(model).includes(keywordNorm)) {
                results.push({
                  make,
                  year: entryYear,
                  model,
                  url: entry.url,
                  path: entry.segments.join("/"),
                });
              }
            }
          } catch {
            failedPages++;
          }
        })
      );

      results.sort((a, b) => {
        const yearDiff = parseInt(b.year) - parseInt(a.year);
        if (yearDiff !== 0) return yearDiff;
        return a.model.localeCompare(b.model);
      });

      const scope =
        year != null
          ? `year ${year}`
          : recent_only
            ? "5 most recent years"
            : `all ${yearsToSearch.length} available years`;
      const note =
        results.length === 0 && failedPages === yearsToSearch.length
          ? `Could not reach LEMON Manuals for any of ${failedPages} year(s) searched — upstream may be down. This is not a "no results" answer; do not treat it as one.`
          : results.length === 0
            ? `No manuals found matching "${keyword ?? ""}" for ${make}${year ? ` ${year}` : ""}.`
            : failedPages > 0
              ? `${failedPages} of ${yearsToSearch.length} year(s) could not be fetched and were skipped; results may be incomplete.`
              : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                keyword: keyword ?? null,
                year: year ?? null,
                recent_only: !!recent_only,
                scope,
                results,
                count: results.length,
                failed_pages: failedPages,
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
      const markdown = await resolveMarkdownImageUrls(htmlToMarkdown(html, finalUrl));
      return {
        content: [
          {
            type: "text",
            text: markdown,
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

      const failedPages = pages.filter((p) => p === null).length;

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

      const note =
        results.length === 0 && failedPages > 0 && failedPages === targets.length
          ? `Could not reach LEMON Manuals for any of ${failedPages} matching page(s) — upstream may be down. This is not a "no entries" answer; do not treat it as one.`
          : results.length === 0
            ? `No labor time entries found for "${component}"${operation ? ` / "${operation}"` : ""}. Try a broader keyword, or use browse_manuals with path "${basePath}/Labor Times" to explore the tree.`
            : truncated
              ? `Component keyword matched more than ${MAX_LEAVES} pages; only the first ${MAX_LEAVES} were fetched. Narrow the component or operation keyword for full coverage.`
              : failedPages > 0
                ? `${failedPages} of ${targets.length} matching page(s) could not be fetched and were skipped; results may be incomplete.`
                : undefined;

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
                failed_pages: failedPages,
                truncated,
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

  // Tool 7: search_diagnosis
  server.registerTool(
    "search_diagnosis",
    {
      description:
        "Search a vehicle's Repair and Diagnosis manual sections by symptom text. Crawls the Repair and Diagnosis subtree, ranks sections by keyword match density, and returns the top 3–5 matches with paths and snippets. Use this when you don't know which section covers a specific customer complaint (e.g. 'rear AC blows hot', 'knocking when cold').",
      inputSchema: {
        make: z.string().min(1).describe('Vehicle make, e.g. "Ford", "Toyota". Use list_makes to see all available makes.'),
        year: z.string().min(1).describe('4-digit model year, e.g. "2011".'),
        model: z
          .string()
          .min(1)
          .describe('Model name (partial, case/hyphen/space-insensitive), e.g. "E450", "F-150", "Crown Victoria".'),
        symptom_text: z
          .string()
          .min(1)
          .describe('Symptom in plain language, e.g. "rear AC blows hot", "heater only works on high fan speed", "knocking noise under hood when cold".'),
      },
    },
    async ({ make, year, model, symptom_text }) => {
      const fail = (payload: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      });

      const tokens = tokenizeSymptom(symptom_text);
      if (tokens.length === 0) {
        return fail({ make, year, model, symptom_text, results: [], note: "symptom_text produced no searchable tokens after filtering." });
      }

      const { modelEntry, available } = await locateModel(make, year, model);
      if (!modelEntry) {
        return fail({
          make,
          year,
          model,
          symptom_text,
          results: [],
          note: `No model matching "${model}" found for ${make} ${year}. Available: ${available.join(", ") || "(none)"}`,
        });
      }

      const rdLink = await locateRepairDiagnosis(modelEntry);
      if (!rdLink) {
        return fail({
          make,
          year,
          model: modelEntry.segments[2],
          symptom_text,
          results: [],
          note: `No "Repair and Diagnosis" section found for ${modelEntry.segments[2]}.`,
        });
      }

      const rdSegs = rdLink.segments;
      const { html: rdHtml, finalUrl: rdUrl } = await fetchUrl(rdLink.url);
      const rdLinks = extractLinks(rdHtml, rdUrl);
      const isDownload = (l: LinkEntry) => /\.zip$/i.test(l.pathname) || /^\/bundle\//i.test(l.pathname);

      const candidateMap = new Map<string, LinkEntry>();
      for (const l of descendantLinks(rdLinks, rdSegs)) {
        if (!isDownload(l)) candidateMap.set(l.pathname, l);
      }

      // Expand one level: fetch direct-child section pages to discover deeper
      // anchors not already rendered on the R&D index page.
      const systems = directChildren(rdLinks, rdSegs).slice(0, 20);
      const childPages = await Promise.all(
        systems.map(async (s) => {
          try {
            const { html, finalUrl } = await fetchUrl(s.url);
            return extractLinks(html, finalUrl);
          } catch {
            return [] as LinkEntry[];
          }
        })
      );
      for (const links of childPages) {
        for (const l of descendantLinks(links, rdSegs)) {
          if (!isDownload(l) && !candidateMap.has(l.pathname)) candidateMap.set(l.pathname, l);
        }
      }

      const candidates = [...candidateMap.values()].map((l) => {
        const title = l.segments[l.segments.length - 1];
        const system = l.segments[rdSegs.length] ?? title;
        const titleScore = scoreText(title, tokens) * 3 + (system !== title ? scoreText(system, tokens) : 0);
        return { link: l, title, system, titleScore };
      });

      const topByTitle = candidates
        .slice()
        .sort((a, b) => b.titleScore - a.titleScore)
        .slice(0, 12);

      interface ScoredResult {
        section_title: string;
        system: string;
        relevance_score: number;
        path: string;
        url: string;
        snippet: string;
      }

      let failedPages = 0;
      const scored = (
        await Promise.all(
          topByTitle.map(async (c): Promise<ScoredResult | null> => {
            try {
              const { html, finalUrl } = await fetchUrl(c.link.url);
              const content = htmlToMarkdown(html, finalUrl);
              const contentHits = scoreText(content, tokens);
              const wordCount = content.split(/\s+/).filter(Boolean).length;
              const relevance = relevanceScore(c.titleScore, contentHits, wordCount, tokens.length);
              if (relevance === 0) return null;
              return {
                section_title: c.title,
                system: c.system,
                relevance_score: relevance,
                path: c.link.segments.join("/"),
                url: c.link.url,
                snippet: extractSnippet(content, tokens),
              };
            } catch {
              failedPages++;
              return null;
            }
          })
        )
      )
        .filter((r): r is ScoredResult => r !== null && r.relevance_score > 0)
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, 5);

      const note =
        scored.length === 0 && failedPages > 0 && failedPages === topByTitle.length
          ? `Could not reach LEMON Manuals for any of ${failedPages} candidate page(s) — upstream may be down. This is not a "no matches" answer; do not treat it as one.`
          : scored.length === 0
            ? "No matching sections found. Try broader symptom terms or use browse_manuals to explore the Repair and Diagnosis tree manually."
            : failedPages > 0
              ? `${failedPages} candidate page(s) could not be fetched and were skipped; results may be incomplete.`
              : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                year,
                model: modelEntry.segments[2],
                symptom_text,
                results: scored,
                count: scored.length,
                failed_pages: failedPages,
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

  // Tool 8: lookup_dtc
  server.registerTool(
    "lookup_dtc",
    {
      description:
        "Look up a Diagnostic Trouble Code (DTC) for a specific vehicle and return its description, system, module, and a direct URL to the pinpoint test — all in one call. Reduces DTC lookup from 4+ tool calls to 1. Crawls Repair and Diagnosis → systems → modules → DTC Index pages, parses the code tables, and returns the pinpoint_test_url (pass to get_manual_content) and pinpoint_test_path (pass to browse_manuals).",
      inputSchema: {
        make: z.string().min(1).describe('Vehicle make, e.g. "Ford", "Toyota". Use list_makes to see valid values.'),
        year: z.string().length(4).describe('4-digit model year, e.g. "2011".'),
        model: z
          .string()
          .min(1)
          .describe('Model name (partial, case/hyphen/space-insensitive), e.g. "E450", "Crown Victoria V8-4.6L". Use search_manuals to find the exact name.'),
        dtc_code: z.string().min(2).describe('DTC code to look up, e.g. "P0128", "B1234", "C0035". Case-insensitive.'),
      },
    },
    async ({ make, year, model, dtc_code }) => {
      const targetDtc = dtc_code.toUpperCase().trim();
      const fail = (payload: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      });

      const { modelEntry, available } = await locateModel(make, year, model);
      if (!modelEntry) {
        return fail({ error: `No model matching "${model}" found for ${make} ${year}.`, available });
      }

      const rdLink = await locateRepairDiagnosis(modelEntry);
      if (!rdLink) {
        return fail({ error: `No "Repair and Diagnosis" section found for ${modelEntry.segments[2]}.` });
      }

      const rdSegs = rdLink.segments;
      const { html: rdHtml, finalUrl: rdUrl } = await fetchUrl(rdLink.url);
      const rdLinks = extractLinks(rdHtml, rdUrl);
      const isDtcIndex = (l: LinkEntry) =>
        (l.segments[l.segments.length - 1] ?? "").toLowerCase().includes("dtc index");

      // LEMON renders the full subtree of anchors on a section index, so DTC
      // Index pages are usually all reachable from the R&D page directly.
      const dtcMap = new Map<string, LinkEntry>();
      for (const l of descendantLinks(rdLinks, rdSegs).filter(isDtcIndex)) {
        dtcMap.set(l.pathname, l);
      }

      // Fallback: crawl direct-child system pages if none surfaced on the index.
      if (dtcMap.size === 0) {
        const systems = directChildren(rdLinks, rdSegs).slice(0, 25);
        const sysPages = await Promise.all(
          systems.map(async (s) => {
            try {
              const { html, finalUrl } = await fetchUrl(s.url);
              return extractLinks(html, finalUrl);
            } catch {
              return [] as LinkEntry[];
            }
          })
        );
        for (const links of sysPages) {
          for (const l of descendantLinks(links, rdSegs).filter(isDtcIndex)) {
            dtcMap.set(l.pathname, l);
          }
        }
      }

      const dtcIndexLinks = [...dtcMap.values()];
      if (dtcIndexLinks.length === 0) {
        return fail({
          error: `No DTC Index pages found for ${make} ${year} ${modelEntry.segments[2]}.`,
          note: "Use browse_manuals to explore the Repair and Diagnosis tree manually.",
        });
      }

      const MAX_DTC_PAGES = 40;
      const truncated = dtcIndexLinks.length > MAX_DTC_PAGES;
      const targets = dtcIndexLinks.slice(0, MAX_DTC_PAGES);

      let failedPages = 0;
      const searchResults = await Promise.all(
        targets.map(async (entry) => {
          try {
            const { html, finalUrl } = await fetchUrl(entry.url);
            const parsed = parseDtcTableHtml(html, finalUrl, targetDtc);
            if (!parsed) return null;
            const pinpointPath = parsed.pinpoint_test_url
              ? pathSegments(new URL(parsed.pinpoint_test_url).pathname).join("/")
              : "";
            return {
              dtc: targetDtc,
              description: parsed.description,
              system: parsed.system_from_table || entry.segments[rdSegs.length] || "",
              module: entry.segments[entry.segments.length - 2] ?? "",
              pinpoint_test_label: parsed.pinpoint_test_label,
              pinpoint_test_url: parsed.pinpoint_test_url,
              pinpoint_test_path: pinpointPath,
              dtc_index_path: entry.segments.join("/"),
            };
          } catch {
            failedPages++;
            return null;
          }
        })
      );

      const found = searchResults.find((r) => r !== null) ?? null;
      if (!found) {
        const allFailed = failedPages > 0 && failedPages === targets.length;
        return fail({
          dtc: targetDtc,
          error: allFailed
            ? `Could not reach LEMON Manuals for any of ${failedPages} DTC Index page(s) — upstream may be down. This is not a "not found" answer; do not treat it as one.`
            : `DTC ${targetDtc} not found in ${make} ${year} ${modelEntry.segments[2]} service manuals.`,
          failed_pages: failedPages,
          note: `Searched ${targets.length} DTC Index page(s) across: ${[...new Set(targets.map((e) => e.segments[rdSegs.length]))].filter(Boolean).join(", ")}.${truncated ? ` More than ${MAX_DTC_PAGES} DTC Index pages exist; only the first ${MAX_DTC_PAGES} were searched.` : ""}`,
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ...found, failed_pages: failedPages }, null, 2) }],
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

// Constant-time string compare so token checks don't leak timing info about
// how many leading bytes matched. timingSafeEqual throws on length mismatch,
// so unequal-length inputs are rejected up front (that early-out is on
// length only, not content, so it doesn't leak the token itself).
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function runHttp() {
  const token = process.env.MCP_AUTH_TOKEN;

  if (!token) {
    if (process.env.ALLOW_NO_AUTH !== "1") {
      console.error(
        "MCP_AUTH_TOKEN is not set. Refusing to start the HTTP transport without auth. " +
          "Set MCP_AUTH_TOKEN, or set ALLOW_NO_AUTH=1 to explicitly run without auth (not recommended)."
      );
      process.exit(1);
    }
    console.error(
      "WARNING: MCP_AUTH_TOKEN is not set and ALLOW_NO_AUTH=1 — the HTTP transport is running with NO authentication."
    );
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", async (req, res) => {
    if (req.query.deep !== "1") {
      res.json({ ok: true, service: "lemon-mcp", version: VERSION, mirrors: BASES });
      return;
    }
    try {
      const { finalUrl } = await fetchDir("");
      res.json({ ok: true, service: "lemon-mcp", version: VERSION, mirrors: BASES, probed: finalUrl });
    } catch (err) {
      res.status(503).json({
        ok: false,
        service: "lemon-mcp",
        version: VERSION,
        mirrors: BASES,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.all("/mcp", async (req, res) => {
    if (token) {
      const auth = req.headers.authorization ?? "";
      const qpRaw = req.query.token;
      const qp = Array.isArray(qpRaw) ? qpRaw[0] : qpRaw;
      const headerOk = auth.startsWith("Bearer ") && safeEqual(auth.slice("Bearer ".length), token);
      const queryOk = typeof qp === "string" && safeEqual(qp, token);
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
        res.status(500).json({ error: "Internal server error" });
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
