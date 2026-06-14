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

interface LaborTimeEntry {
  component: string;
  operation: string;
  time_hours: number | null;
  notes: string;
  path: string;
}

function getDirectChildren(markdown: string, parentUrl: string): LinkEntry[] {
  const links = extractCharmLinks(markdown, BASE_URL + "/");
  const normalized = parentUrl.replace(/\/$/, "");
  return links.filter((link) => {
    if (!link.url.startsWith(normalized + "/")) return false;
    if (link.url === normalized + "/") return false;
    const remainder = link.url.slice(normalized.length + 1).replace(/\/$/, "");
    return remainder.length > 0 && !remainder.includes("/");
  });
}

function parseLaborTime(content: string): { time_hours: number | null; notes: string } {
  const lc = content.toLowerCase();

  // "included" means time is bundled with another operation
  if (/\bincluded\b/.test(lc)) {
    return { time_hours: null, notes: "included" };
  }

  // Look for overlap credit note
  const overlapMatch = content.match(/overlap\s+credit[^.\n]*/i);

  // Find first plausible decimal hour value (0.1 – 99.9)
  const numMatch = content.match(/\b(\d{1,2}\.\d)\b/);
  if (numMatch) {
    const time_hours = parseFloat(numMatch[1]);
    if (time_hours > 0 && time_hours < 100) {
      return { time_hours, notes: overlapMatch ? overlapMatch[0].trim() : "" };
    }
  }

  return { time_hours: null, notes: overlapMatch ? overlapMatch[0].trim() : "" };
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
        "Search for service manuals by car make and optional keyword. If the query includes a 4-digit year (e.g. '2010'), only that year is searched. Otherwise, the most recent available years are searched. Returns matching model/manual entries with URLs.",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe(
            'Car make to search within, e.g. "Ford", "Toyota". Use list_makes to see all available makes.'
          ),
        query: z
          .string()
          .optional()
          .describe(
            'Optional search keyword. Can be a year (e.g. "2010"), model name (e.g. "F-150"), engine (e.g. "V8"), or combination (e.g. "2010 F-150").'
          ),
      },
    },
    async ({ make, query }) => {
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
                  query,
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

      let yearsToSearch: typeof yearEntries;
      if (query) {
        const yearMatch = query.match(/\b(19|20)\d{2}\b/);
        if (yearMatch) {
          const targetYear = yearMatch[0];
          yearsToSearch = yearEntries.filter((e) => e.text === targetYear);
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
                      note: `Year ${targetYear} not found for ${make}. Available years: ${yearEntries.map((e) => e.text).join(", ")}`,
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
      } else {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  make,
                  query: null,
                  results: yearEntries.map((e) => ({
                    label: e.text,
                    url: e.url,
                    path: e.url
                      .replace(`${BASE_URL}/`, "")
                      .replace(/\/$/, ""),
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

      const keyword = query
        .replace(/\b(19|20)\d{2}\b/, "")
        .trim()
        .toLowerCase();

      const results: Array<{
        make: string;
        year: string;
        model: string;
        url: string;
        path: string;
      }> = [];

      await Promise.all(
        yearsToSearch.map(async (yearEntry) => {
          const year = yearEntry.text;
          try {
            const yearMarkdown = await fetchMarkdown(yearEntry.url);
            const modelLinks = extractCharmLinks(yearMarkdown, `${BASE_URL}/`);

            const modelEntries = modelLinks.filter((link) => {
              const withoutBase = link.url.replace(`${BASE_URL}/`, "");
              const parts = withoutBase.replace(/\/$/, "").split("/");
              return parts.length === 3;
            });

            for (const entry of modelEntries) {
              if (!keyword || entry.text.toLowerCase().includes(keyword)) {
                results.push({
                  make,
                  year,
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
                note:
                  results.length === 0
                    ? `No manuals found matching "${query}" for ${make}.`
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
    "lookup_labor_time",
    {
      description:
        "Look up labor times for a specific component on a vehicle from charm.li. " +
        "Searches the Labor Times subtree for the given component keyword and returns " +
        "structured operation/time data. The model parameter must match the exact path " +
        "segment from browse_manuals or search_manuals (e.g. 'E450 Super Duty V10-6.8L'). " +
        "Returns all operations for the component when operation is omitted.",
      inputSchema: {
        make: z
          .string()
          .min(1)
          .describe('Car make, e.g. "Ford", "Toyota". Use list_makes for valid values.'),
        year: z
          .string()
          .length(4)
          .describe('4-digit model year, e.g. "2011".'),
        model: z
          .string()
          .min(1)
          .describe(
            'Exact model path segment as returned by browse_manuals or search_manuals, e.g. "E450 Super Duty V10-6.8L".'
          ),
        component: z
          .string()
          .min(1)
          .describe(
            'Component name to search for (partial, case-insensitive), e.g. "Auxiliary A/C", "Water Pump", "Serpentine Belt".'
          ),
        operation: z
          .string()
          .optional()
          .describe(
            'Specific operation to filter by (partial, case-insensitive), e.g. "Remove & Replace", "Diagnosis", "Testing". Omit to return all operations.'
          ),
      },
    },
    async ({ make, year, model, component, operation }) => {
      const vehicleUrl = charmUrl(`${make}/${year}/${model}`);

      // Step 1: find the "Labor Times" section link on the vehicle page
      let vehicleMarkdown: string;
      try {
        vehicleMarkdown = await fetchMarkdown(vehicleUrl);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Could not fetch vehicle page: ${vehicleUrl}`,
                  hint: "Verify make/year/model using browse_manuals or search_manuals.",
                  details: String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const vehicleLinks = extractCharmLinks(vehicleMarkdown, BASE_URL + "/");
      const laborTimesLink = vehicleLinks.find((l) =>
        l.text.toLowerCase().includes("labor time")
      );

      if (!laborTimesLink) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `No "Labor Times" section found for ${make} ${year} ${model}.`,
                  available_sections: vehicleLinks.map((l) => l.text),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 2: get the top-level categories under Labor Times
      const ltMarkdown = await fetchMarkdown(laborTimesLink.url);
      const categories = getDirectChildren(ltMarkdown, laborTimesLink.url);

      if (categories.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "No categories found under Labor Times.",
                  labor_times_url: laborTimesLink.url,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const componentKeyword = component.toLowerCase();
      const operationKeyword = operation?.toLowerCase();

      // Step 3: fetch all category pages in parallel, collect component links
      const categoryResults = await Promise.all(
        categories.map(async (cat) => {
          try {
            const catMd = await fetchMarkdown(cat.url);
            const children = getDirectChildren(catMd, cat.url);
            const matching = children.filter((c) =>
              c.text.toLowerCase().includes(componentKeyword)
            );
            return { category: cat, matching };
          } catch {
            return { category: cat, matching: [] };
          }
        })
      );

      const allMatches = categoryResults.flatMap((r) =>
        r.matching.map((comp) => ({ category: r.category, comp }))
      );

      if (allMatches.length === 0) {
        const allComponentNames = categoryResults.flatMap((r) =>
          r.matching.length === 0
            ? categoryResults
                .find((cr) => cr.category.url === r.category.url)
                ?.matching.map((c) => c.text) ?? []
            : r.matching.map((c) => c.text)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  results: [],
                  count: 0,
                  note: `No component matching "${component}" found under Labor Times for ${make} ${year} ${model}.`,
                  searched_categories: categories.map((c) => c.text),
                  labor_times_url: laborTimesLink.url,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 4: for each matching component, get its operation sub-pages
      const results: LaborTimeEntry[] = [];

      await Promise.all(
        allMatches.map(async ({ comp }) => {
          let compMd: string;
          try {
            compMd = await fetchMarkdown(comp.url);
          } catch {
            return;
          }

          const ops = getDirectChildren(compMd, comp.url);

          if (ops.length === 0) {
            // Component IS the leaf — parse time directly from its content
            if (
              !operationKeyword ||
              comp.text.toLowerCase().includes(operationKeyword)
            ) {
              const parsed = parseLaborTime(compMd);
              results.push({
                component: comp.text,
                operation: comp.text,
                time_hours: parsed.time_hours,
                notes: parsed.notes,
                path: comp.url.replace(`${BASE_URL}/`, "").replace(/\/$/, ""),
              });
            }
            return;
          }

          // Filter operations by keyword if provided
          const targetOps = operationKeyword
            ? ops.filter((op) =>
                op.text.toLowerCase().includes(operationKeyword)
              )
            : ops;

          // Step 5: fetch each operation page and parse the time
          await Promise.all(
            targetOps.map(async (op) => {
              try {
                const opContent = await fetchMarkdown(op.url);
                const parsed = parseLaborTime(opContent);
                results.push({
                  component: comp.text,
                  operation: op.text,
                  time_hours: parsed.time_hours,
                  notes: parsed.notes,
                  path: op.url
                    .replace(`${BASE_URL}/`, "")
                    .replace(/\/$/, ""),
                });
              } catch {
                // skip failed fetches
              }
            })
          );
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                results,
                count: results.length,
                note:
                  results.length === 0
                    ? `Component "${component}" was found but no operations matched${operation ? ` filter "${operation}"` : ""}.`
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
