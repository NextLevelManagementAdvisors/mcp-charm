# lemon-mcp

MCP server for [LEMON Manuals](https://lemon-manuals.la) — free car service/workshop manuals for ~10,000 US/Canada market vehicles, model years 1960-2025 (includes the classic Operation CHARM 1982-2013 data). Content includes service manuals, technical service bulletins, and labor times.

Fork of [Gonzih/mcp-charm](https://github.com/Gonzih/mcp-charm) (MIT). Changes from upstream:

- Targets LEMON Manuals with automatic mirror failover (lemon-manuals.la → .org.ua → .gy)
- Direct HTML fetch and parse (removed the r.jina.ai proxy dependency)
- Streamable HTTP transport with optional bearer-token auth (stdio remains the default)
- Dockerfile for containerized deployment
- Adds zod as an explicit dependency (upstream relied on hoisting)

## Tools

- `list_makes` — all vehicle makes
- `browse_make(make)` — available years for a make
- `browse_manuals(path)` — e.g. `Ford/2018` or `Ford/2018/F 150 4WD V8-5.0L`
- `search_manuals(make, query)` — e.g. `search_manuals("Ford", "2018 F-150")`
- `get_manual_content(url)` — page content as markdown (procedures, images, section links, zip downloads)

## Environment

- `LEMON_BASE_URLS` — comma-separated mirror list (default: `https://lemon-manuals.la,https://lemon-manuals.org.ua,https://lemon-manuals.gy`)
- `MCP_AUTH_TOKEN` — if set, HTTP mode requires `Authorization: Bearer <token>`
- `PORT` — HTTP port (default `8080`)
- `MCP_TRANSPORT` — `http` or `stdio` (default `stdio`; CLI arg `http` also works)

## Run

```bash
# stdio (Claude Desktop etc.)
npm install && npm run build && node dist/index.js

# HTTP (behind nginx reverse proxy)
MCP_AUTH_TOKEN=changeme node dist/index.js http

# Docker
docker build -t lemon-mcp .
docker run -d --name lemon-mcp -p 8080:8080 -e MCP_AUTH_TOKEN=changeme lemon-mcp
```

Health check: `GET /health`. MCP endpoint: `POST /mcp` (streamable HTTP, stateless).

## Credits

- Upstream MCP server: [Gonzih/mcp-charm](https://github.com/Gonzih/mcp-charm) (MIT)
- Manual data: [LEMON Manuals](https://lemon-manuals.la) and [Operation CHARM](https://charm.li)
