#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

const BASE_URL = "https://charm.li";
const JINA_PREFIX = "https://r.jina.ai/";

async function fetchMarkdown(url: string): Promise<string> {
  const jinaUrl = `${JINA_PREFIX}${url}`;
  const response = await fetch(jinaUrl, {
    headers: {
      "User-Agent": "mcp-charm/0.2.0 (https://github.com/gonzih/mcp-charm)",
      Accept: "text/plain",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

interface LinkEntry {
  text: string;
  url: string;
}

interface DtcResult {
  dtc: string;
  description: string;
  system: string;
  module: string;
  pinpoint_test_label: string;
  pinpoint_test_url: string;
}

function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
}

function safeDecodeUri(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function isUrlDirectChild(childUrl: string, parentUrl: string): boolean {
  const parent = safeDecodeUri(parentUrl.replace(/\/$/, "") + "/");
  const child = safeDecodeUri(childUrl);
  if (!child.startsWith(parent) || child === parent) return false;
  const subPath = child.replace(parent, "").replace(/\/$/, "");
  return !subPath.includes("/");
}

function parseDtcTable(
  markdown: string,
  targetDtc: string
): {
  description: string;
  system_from_table: string;
  pinpoint_test_label: string;
  pinpoint_test_url: string;
} | null {
  const lines = markdown.split("\n");
  let state: "none" | "header" | "data" = "none";
  let headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("|")) {
      state = "none";
      headers = [];
      continue;
    }

    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());

    if (cells.every((c) => /^[-: ]+$/.test(c))) {
      if (state === "header") state = "data";
      continue;
    }

    if (state !== "data") {
      headers = cells.map((c) => stripMarkdownLinks(c).trim().toLowerCase());
      state = "header";
      continue;
    }

    const dtcCell = stripMarkdownLinks(cells[0] ?? "").toUpperCase().trim();
    if (dtcCell !== targetDtc) continue;

    const indexOf = (needles: string[]): number => {
      for (const needle of needles) {
        const idx = headers.findIndex((h) => h.includes(needle));
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const descIdx = indexOf(["description", "condition"]);
    const sysIdx = indexOf(["system", "subsystem"]);
    const ptIdx = indexOf(["pinpoint"]);

    const description =
      descIdx >= 0 && descIdx < cells.length
        ? stripMarkdownLinks(cells[descIdx] ?? "")
        : cells.length > 1
          ? stripMarkdownLinks(cells[1] ?? "")
          : "";

    const systemFromTable =
      sysIdx >= 0 && sysIdx < cells.length
        ? stripMarkdownLinks(cells[sysIdx] ?? "")
        : "";

    const pinpointCellIdx = ptIdx >= 0 ? ptIdx : cells.length - 1;
    const pinpointCell =
      pinpointCellIdx < cells.length ? (cells[pinpointCellIdx] ?? "") : "";

    const linkMatch = pinpointCell.match(
      /\[([^\]]+)\]\((https?:\/\/charm\.li\/[^)]+)\)/
    );

    return {
      description,
      system_from_table: systemFromTable,
      pinpoint_test_label: linkMatch
        ? linkMatch[1].trim()
        : stripMarkdownLinks(pinpointCell),
      pinpoint_test_url: linkMatch
        ? safeDecodeUri(
            linkMatch[2].replace(`${BASE_URL}/`, "").replace(/\/$/, "")
          )
        : "",
    };
  }

  return null;
}

function extractCharmLinks(markdown: string, pathPrefix?: string): LinkEntry[] {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/charm\.li\/[^)]+)\)/g;
  const seen = new Set<string>();
  const results: LinkEntry[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(markdown)) !== null) {
    const text = match[1].trim();
    const url = match[2].trim();

    if (text === "Home" || text === "About Operation CHARM") continue;
    if (pathPrefix && !url.startsWith(pathPrefix)) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    results.push({ text, url });
  }

  return results;
}

function validateCharmUrl(url: string): void {
  if (!url.startsWith(`${BASE_URL}/`)) {
    throw new Error(`URL must start with ${BASE_URL}/ — got: ${url}`);
  }
}

function charmUrl(path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${BASE_URL}/${normalized}/`;
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-charm",
    version: "0.2.0",
  });

  server.registerTool(
    "list_makes",
    {
      description:
        "List all car makes available on charm.li (Operation CHARM free service manuals). Returns an array of make names like Acura, BMW, Ford, Toyota, etc.",
      inputSchema: {},
    },
    async () => {
      const markdown = await fetchMarkdown(BASE_URL + "/");
      const links = extractCharmLinks(markdown, `${BASE_URL}/`);

      const makes = links
        .filter((link) => {
          const path = link.url.replace(`${BASE_URL}/`, "").replace(/\/$/, "");
          return path.length > 0 && !path.includes("/");
        })
        .map((link) => ({
          name: link.text,
          url: link.url,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                makes: makes.map((m) => m.name),
                count: makes.length,
                details: makes,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "browse_make",
    {
      description:
        "Browse available years for a given car make on charm.li. For example, browse_make('Ford') returns all years (1982–2013) for which Ford manuals exist. Use browse_manuals with a year path to see models for that year.",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe(
            'Car make name, e.g. "Ford", "BMW", "Toyota". Use list_makes to see all available makes.'
          ),
      },
    },
    async ({ make }) => {
      const url = charmUrl(make);
      const markdown = await fetchMarkdown(url);
      const links = extractCharmLinks(markdown, `${BASE_URL}/`);

      const entries = links
        .filter((link) => {
          const withoutBase = link.url.replace(`${BASE_URL}/`, "");
          const parts = withoutBase.replace(/\/$/, "").split("/");
          return parts.length === 2;
        })
        .map((link) => ({
          label: link.text,
          url: link.url,
          path: link.url.replace(`${BASE_URL}/`, "").replace(/\/$/, ""),
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                url,
                entries,
                count: entries.length,
                note: `Use browse_manuals with path like "${make}/2010" to see models for a specific year.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "browse_manuals",
    {
      description:
        'Browse manuals at a specific path on charm.li. Use paths like "Ford/2010" to see model+engine combos, or "Ford/2010/Crown Victoria V8-4.6L" to see manual sections (Repair and Diagnosis, Parts and Labor).',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Path within charm.li, e.g. "Ford/2010", "Toyota/2005", "Ford/2010/Crown Victoria V8-4.6L". Do not include leading or trailing slashes.'
          ),
      },
    },
    async ({ path }) => {
      const url = charmUrl(path);
      const markdown = await fetchMarkdown(url);

      const links = extractCharmLinks(markdown, `${BASE_URL}/`);

      const entries = links
        .filter((link) => {
          const normalized = url.replace(/\/$/, "");
          return (
            link.url.startsWith(normalized + "/") &&
            link.url !== normalized + "/"
          );
        })
        .map((link) => {
          const relativePath = link.url.replace(url, "").replace(/\/$/, "");
          const isDirectory = link.url.endsWith("/");
          return {
            name: link.text,
            url: link.url,
            path: path + "/" + relativePath,
            type: isDirectory ? "directory" : "file",
          };
        });

      const filePattern =
        /\[([^\]]+)\]\((https?:\/\/charm\.li\/bundle\/[^)]+)\)/g;
      const bundles: Array<{ name: string; url: string; type: string }> = [];
      let match: RegExpExecArray | null;
      while ((match = filePattern.exec(markdown)) !== null) {
        bundles.push({
          name: match[1].trim(),
          url: match[2].trim(),
          type: "download",
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path,
                url,
                entries: [...entries, ...bundles],
                count: entries.length + bundles.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "search_manuals",
    {
      description:
        "Search for service manuals by car make and optional keyword. When 'year' is provided, only that year is searched. When 'year' is omitted, all available years are searched by default. Set 'recent_only' to true to limit the search to the 5 most recent years instead. Returns matching model/manual entries with URLs.",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe(
            'Car make to search within, e.g. "Ford", "Toyota". Use list_makes to see all available makes.'
          ),
        keyword: z
          .string()
          .optional()
          .describe(
            'Optional search keyword to filter models, e.g. "F-150", "V8", "Auxiliary Heater", "P0128". When omitted, returns the list of available years for the make.'
          ),
        year: z
          .string()
          .optional()
          .describe(
            'Optional 4-digit model year to scope the search, e.g. "2011". When provided, only that year is searched. When omitted, all available years are searched (unless recent_only is true).'
          ),
        recent_only: z
          .boolean()
          .optional()
          .describe(
            'When true, limit the search to the 5 most recent years for the make instead of searching all years. Defaults to false. Ignored when a specific year is provided.'
          ),
      },
    },
    async ({ make, keyword, year, recent_only }) => {
      const makeUrl = charmUrl(make);
      const makeMarkdown = await fetchMarkdown(makeUrl);
      const allLinks = extractCharmLinks(makeMarkdown, `${BASE_URL}/`);

      const yearEntries = allLinks.filter((link) => {
        const withoutBase = link.url.replace(`${BASE_URL}/`, "");
        const parts = withoutBase.replace(/\/$/, "").split("/");
        return parts.length === 2;
      });

      if (yearEntries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  make,
                  keyword,
                  year,
                  results: [],
                  note: "No years found for this make.",
                },
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
                    label: e.text,
                    url: e.url,
                    path: e.url
                      .replace(`${BASE_URL}/`, "")
                      .replace(/\/$/, ""),
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
        yearsToSearch = yearEntries.filter((e) => e.text === year);
        if (yearsToSearch.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    make,
                    keyword,
                    year,
                    results: [],
                    note: `Year ${year} not found for ${make}. Available years: ${yearEntries.map((e) => e.text).join(", ")}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } else if (recent_only) {
        yearsToSearch = yearEntries.slice(-5);
      } else {
        yearsToSearch = yearEntries;
      }

      const normalizedKeyword = (keyword ?? "").trim().toLowerCase();

      const results: Array<{
        make: string;
        year: string;
        model: string;
        url: string;
        path: string;
      }> = [];

      await Promise.all(
        yearsToSearch.map(async (yearEntry) => {
          const entryYear = yearEntry.text;
          try {
            const yearMarkdown = await fetchMarkdown(yearEntry.url);
            const modelLinks = extractCharmLinks(yearMarkdown, `${BASE_URL}/`);

            const modelEntries = modelLinks.filter((link) => {
              const withoutBase = link.url.replace(`${BASE_URL}/`, "");
              const parts = withoutBase.replace(/\/$/, "").split("/");
              return parts.length === 3;
            });

            for (const entry of modelEntries) {
              if (!normalizedKeyword || entry.text.toLowerCase().includes(normalizedKeyword)) {
                results.push({
                  make,
                  year: entryYear,
                  model: entry.text,
                  url: entry.url,
                  path: entry.url
                    .replace(`${BASE_URL}/`, "")
                    .replace(/\/$/, ""),
                });
              }
            }
          } catch {
            // Skip years that fail to fetch
          }
        })
      );

      results.sort((a, b) => {
        const yearDiff = parseInt(b.year) - parseInt(a.year);
        if (yearDiff !== 0) return yearDiff;
        return a.model.localeCompare(b.model);
      });

      const searchScopeNote = year
        ? `year ${year}`
        : recent_only
          ? "the 5 most recent years"
          : "all available years";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                keyword: keyword ?? null,
                year: year ?? null,
                recent_only: recent_only ?? false,
                results,
                count: results.length,
                note:
                  results.length === 0
                    ? `No manuals found matching "${keyword ?? ""}" in ${searchScopeNote} for ${make}.`
                    : `Searched ${searchScopeNote} for ${make}.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "search_diagnosis",
    {
      description:
        "Search a vehicle's Repair & Diagnosis manual sections by symptom text. Crawls the Repair & Diagnosis subtree, ranks sections by keyword match density, and returns the top 3–5 matches with paths and snippets. Use this when you don't know which section covers a specific customer complaint (e.g. 'rear AC blows hot', 'knocking when cold').",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe('Car make, e.g. "Ford", "Toyota". Use list_makes to see all available makes.'),
        year: z
          .string()
          .length(4)
          .describe('4-digit model year, e.g. "2011".'),
        model: z
          .string()
          .min(1)
          .describe('Model name (partial match supported), e.g. "E450", "F-150", "Crown Victoria".'),
        symptom_text: z
          .string()
          .min(1)
          .describe('Symptom in plain language, e.g. "rear AC blows hot", "heater only works on high fan speed", "knocking noise under hood when cold".'),
      },
    },
    async ({ make, year, model, symptom_text }) => {
      // Tokenize symptom — drop short stop-words
      const symptomTokens = symptom_text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2);

      if (symptomTokens.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "symptom_text produced no searchable tokens after filtering." },
                null,
                2
              ),
            },
          ],
        };
      }

      function scoreText(text: string): number {
        const lower = text.toLowerCase();
        let score = 0;
        for (const token of symptomTokens) {
          const re = new RegExp(token, "g");
          const hits = lower.match(re);
          if (hits) score += hits.length;
        }
        return score;
      }

      function extractSnippet(markdown: string, maxLen = 220): string {
        // Strip markdown link syntax and leading junk for readability
        const cleaned = markdown
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/[#*_`>]/g, "")
          .replace(/\n{2,}/g, "\n")
          .trim();

        const lower = cleaned.toLowerCase();
        let bestIdx = -1;
        for (const token of symptomTokens) {
          const idx = lower.indexOf(token);
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
        }

        const start = bestIdx === -1 ? 0 : Math.max(0, bestIdx - 60);
        const raw = cleaned.slice(start, start + maxLen).trim();
        return (start > 0 ? "…" : "") + raw + (raw.length >= maxLen ? "…" : "");
      }

      // Step 1: find exact model URL via make/year page
      const yearUrl = charmUrl(`${make}/${year}`);
      let yearMarkdown: string;
      try {
        yearMarkdown = await fetchMarkdown(yearUrl);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { make, year, model, symptom_text, results: [], note: `Could not fetch ${yearUrl}` },
                null,
                2
              ),
            },
          ],
        };
      }

      const allModelLinks = extractCharmLinks(yearMarkdown, `${BASE_URL}/`);
      const modelKeyword = model.toLowerCase();
      const matchingModel = allModelLinks.find((link) => {
        const parts = link.url.replace(`${BASE_URL}/`, "").replace(/\/$/, "").split("/");
        return parts.length === 3 && link.text.toLowerCase().includes(modelKeyword);
      });

      if (!matchingModel) {
        const available = allModelLinks
          .filter((l) => {
            const p = l.url.replace(`${BASE_URL}/`, "").replace(/\/$/, "").split("/");
            return p.length === 3;
          })
          .map((l) => l.text);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  make,
                  year,
                  model,
                  symptom_text,
                  results: [],
                  note: `No model matching "${model}" found for ${make} ${year}. Available: ${available.join(", ")}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 2: find Repair & Diagnosis link on the model page
      const modelMarkdown = await fetchMarkdown(matchingModel.url);
      const modelPageLinks = extractCharmLinks(modelMarkdown, matchingModel.url);
      const rdLink = modelPageLinks.find(
        (l) =>
          l.text.toLowerCase().includes("repair") &&
          l.text.toLowerCase().includes("diagnos")
      );

      if (!rdLink) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  make,
                  year,
                  model: matchingModel.text,
                  symptom_text,
                  results: [],
                  note: `No "Repair & Diagnosis" section found for ${matchingModel.text}.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 3: crawl 2 levels of the R&D subtree
      const rdMarkdown = await fetchMarkdown(rdLink.url);
      const level1Links = extractCharmLinks(rdMarkdown, rdLink.url).filter(
        (l) => l.url !== rdLink.url
      );

      interface Candidate {
        url: string;
        path: string;
        title: string;
        system: string;
        titleScore: number;
      }

      const candidates: Candidate[] = [];

      // Add level-1 sections as candidates
      for (const l1 of level1Links) {
        candidates.push({
          url: l1.url,
          path: l1.url.replace(`${BASE_URL}/`, "").replace(/\/$/, ""),
          title: l1.text,
          system: l1.text,
          titleScore: scoreText(l1.text) * 3,
        });
      }

      // Fetch level-2 sections in parallel
      await Promise.all(
        level1Links.map(async (l1) => {
          try {
            const l1Markdown = await fetchMarkdown(l1.url);
            const l2Links = extractCharmLinks(l1Markdown, l1.url).filter(
              (l) => l.url !== l1.url
            );
            for (const l2 of l2Links) {
              candidates.push({
                url: l2.url,
                path: l2.url.replace(`${BASE_URL}/`, "").replace(/\/$/, ""),
                title: l2.text,
                system: l1.text,
                titleScore: scoreText(l2.text) * 3 + scoreText(l1.text),
              });
            }
          } catch {
            // skip unreachable sections
          }
        })
      );

      // Step 4: score candidates — fetch content for top candidates by title score
      const topByTitle = candidates
        .slice()
        .sort((a, b) => b.titleScore - a.titleScore)
        .slice(0, 12);

      interface ScoredResult {
        section_title: string;
        system: string;
        relevance_score: number;
        path: string;
        snippet: string;
      }

      const scored: ScoredResult[] = (
        await Promise.all(
          topByTitle.map(async (c) => {
            try {
              const content = await fetchMarkdown(c.url);
              const contentHits = scoreText(content);
              const wordCount = Math.max(1, content.split(/\s+/).length);
              const density = contentHits / wordCount;

              // Composite: title match (weight 0.5) + raw content hits (0.3) + density (0.2)
              const raw =
                (c.titleScore / (symptomTokens.length * 3)) * 0.5 +
                Math.min(1, contentHits / (symptomTokens.length * 5)) * 0.3 +
                Math.min(1, density * 500) * 0.2;

              const relevance_score = Math.round(Math.min(1, raw) * 100) / 100;

              if (relevance_score === 0 && contentHits === 0 && c.titleScore === 0) return null;

              return {
                section_title: c.title,
                system: c.system,
                relevance_score,
                path: c.path,
                snippet: extractSnippet(content),
              } satisfies ScoredResult;
            } catch {
              return null;
            }
          })
        )
      )
        .filter((r): r is ScoredResult => r !== null && r.relevance_score > 0)
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, 5);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                make,
                year,
                model: matchingModel.text,
                symptom_text,
                results: scored,
                count: scored.length,
                note:
                  scored.length === 0
                    ? "No matching sections found. Try broader symptom terms or use browse_manuals to explore the Repair & Diagnosis tree manually."
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

  server.registerTool(
    "get_manual_content",
    {
      description:
        "Fetch the content of a specific charm.li page — returns the page as markdown including links to manual sections and PDF files. The URL must start with https://charm.li/.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(
            "Full URL of a charm.li page, e.g. https://charm.li/Ford/2010/Crown%20Victoria%20V8-4.6L/. Must start with https://charm.li/."
          ),
      },
    },
    async ({ url }) => {
      validateCharmUrl(url);
      const markdown = await fetchMarkdown(url);
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

  server.registerTool(
    "lookup_dtc",
    {
      description:
        "Look up a Diagnostic Trouble Code (DTC) for a specific vehicle and return its description, system, module, and a direct URL to the pinpoint test — all in one call. Reduces DTC lookup from 4+ tool calls to 1. The returned pinpoint_test_url is a charm.li path that can be passed to browse_manuals() or prefixed with https://charm.li/ for get_manual_content().",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe(
            'Car make, e.g. "Ford", "Toyota". Use list_makes() to see valid values.'
          ),
        year: z
          .string()
          .length(4)
          .describe('4-digit model year, e.g. "2011".'),
        model: z
          .string()
          .min(1)
          .describe(
            'Exact model name as it appears on charm.li, e.g. "E-450 Stripped Chassis", "Crown Victoria V8-4.6L". Use search_manuals() to find the exact name.'
          ),
        dtc_code: z
          .string()
          .min(2)
          .describe(
            'DTC code to look up, e.g. "P0128", "B1234", "C0035". Case-insensitive.'
          ),
      },
    },
    async ({ make, year, model, dtc_code }) => {
      const targetDtc = dtc_code.toUpperCase().trim();

      const repairUrl = charmUrl(
        `${make}/${year}/${model}/Repair & Diagnosis`
      );

      let repairMarkdown: string;
      try {
        repairMarkdown = await fetchMarkdown(repairUrl);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Could not fetch Repair & Diagnosis section for ${make} ${year} ${model}`,
                  detail: String(err),
                  url: repairUrl,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Find system-level directories (e.g. Powertrain, Body, Chassis)
      const allRepairLinks = extractCharmLinks(repairMarkdown, `${BASE_URL}/`);
      const systemLinks = allRepairLinks.filter((link) =>
        isUrlDirectChild(link.url, repairUrl)
      );

      if (systemLinks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `No diagnostic systems found for ${make} ${year} ${model}`,
                  url: repairUrl,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // For each system, find module directories
      const moduleEntries: Array<{
        url: string;
        system: string;
        name: string;
      }> = [];

      await Promise.all(
        systemLinks.map(async (sysLink) => {
          try {
            const sysMarkdown = await fetchMarkdown(sysLink.url);
            const sysLinks = extractCharmLinks(sysMarkdown, `${BASE_URL}/`);
            const modules = sysLinks.filter((link) =>
              isUrlDirectChild(link.url, sysLink.url)
            );
            for (const mod of modules) {
              moduleEntries.push({
                url: mod.url,
                system: sysLink.text,
                name: mod.text,
              });
            }
          } catch {
            // Skip inaccessible systems
          }
        })
      );

      // For each module, find DTC Index pages
      const dtcIndexEntries: Array<{
        url: string;
        system: string;
        module: string;
      }> = [];

      await Promise.all(
        moduleEntries.map(async (modEntry) => {
          try {
            const modMarkdown = await fetchMarkdown(modEntry.url);
            const modLinks = extractCharmLinks(modMarkdown, `${BASE_URL}/`);
            const dtcLinks = modLinks.filter(
              (link) =>
                isUrlDirectChild(link.url, modEntry.url) &&
                link.text.toLowerCase().includes("dtc index")
            );
            for (const dtcLink of dtcLinks) {
              dtcIndexEntries.push({
                url: dtcLink.url,
                system: modEntry.system,
                module: modEntry.name,
              });
            }
          } catch {
            // Skip inaccessible modules
          }
        })
      );

      if (dtcIndexEntries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `No DTC Index pages found for ${make} ${year} ${model}`,
                  systems_checked: [
                    ...new Set(moduleEntries.map((m) => m.system)),
                  ],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Search each DTC Index page in parallel
      const searchResults = await Promise.all(
        dtcIndexEntries.map(async (entry) => {
          try {
            const dtcMarkdown = await fetchMarkdown(entry.url);
            const parsed = parseDtcTable(dtcMarkdown, targetDtc);
            if (!parsed) return null;
            const result: DtcResult = {
              dtc: targetDtc,
              description: parsed.description,
              system: parsed.system_from_table || entry.system,
              module: entry.module,
              pinpoint_test_label: parsed.pinpoint_test_label,
              pinpoint_test_url: parsed.pinpoint_test_url,
            };
            return result;
          } catch {
            return null;
          }
        })
      );

      const foundResult = searchResults.find((r) => r !== null) ?? null;

      if (!foundResult) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `DTC ${targetDtc} not found in ${make} ${year} ${model} service manuals`,
                  note: `Searched ${dtcIndexEntries.length} DTC Index page(s) across: ${[...new Set(dtcIndexEntries.map((e) => e.system))].join(", ")}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(foundResult, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : null;

  if (port) {
    const app = createMcpExpressApp({ host: "0.0.0.0" });

    // Health check — must be registered before auth middleware
    app.get("/health", (_req: Request, res: Response) => {
      res.json({ status: "ok", service: "mcp-charm", version: "0.2.0" });
    });

    // Bearer token auth for /mcp
    const authToken = process.env.MCP_AUTH_TOKEN;
    if (authToken) {
      app.use(
        "/mcp",
        (req: Request, res: Response, next: NextFunction): void => {
          const provided = req.headers.authorization?.replace(
            /^Bearer\s+/i,
            ""
          );
          if (provided !== authToken) {
            res.status(401).json({ error: "unauthorized" });
            return;
          }
          next();
        }
      );
    }

    // MCP endpoint — one stateless transport per request
    app.post("/mcp", async (req: Request, res: Response): Promise<void> => {
      try {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: String(err) });
        }
      }
    });

    app.listen(port, "0.0.0.0", () => {
      process.stderr.write(`mcp-charm listening on port ${port}\n`);
    });
  } else {
    // Default: stdio mode for local/npx usage
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
