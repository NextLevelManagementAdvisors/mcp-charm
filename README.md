# mcp-charm

MCP server for **Operation CHARM** — free car service manuals from [charm.li](https://charm.li/).

Browse and search thousands of free car service manuals covering makes from Acura to Volvo, model years 1982 through 2013.

## Hosted MCP Endpoint

The canonical public endpoint for the hosted deployment is:

```
https://manuals.nlma.io/mcp
```

Authentication requires a Bearer token:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

> **Note:** Use `manuals.nlma.io` (plural). The singular `manual.nlma.io` resolves to the same IP but has no TLS certificate and will fail at the TLS handshake.

## Local Install (npx / stdio)

```bash
npx -y @gonzih/mcp-charm
```

### Claude Desktop Configuration (stdio)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "charm": {
      "command": "npx",
      "args": ["-y", "@gonzih/mcp-charm"]
    }
  }
}
```

### Claude Desktop Configuration (hosted HTTP endpoint)

```json
{
  "mcpServers": {
    "charm": {
      "url": "https://manuals.nlma.io/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

## Self-Hosting with Docker Compose

Copy the example env file and set a strong token:

```bash
cp .env.example .env
# edit .env and set MCP_AUTH_TOKEN
```

Start the container:

```bash
docker compose up -d
```

The service listens on `127.0.0.1:3070` (host) → `0.0.0.0:8080` (container).
Nginx or another reverse proxy should terminate TLS and forward to `127.0.0.1:3070`.

Health check:

```bash
curl http://127.0.0.1:3070/health
# {"status":"ok","service":"mcp-charm","version":"0.2.0"}
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | — | Set to `8080` (or any port) to enable HTTP mode. Unset = stdio mode. |
| `MCP_AUTH_TOKEN` | — | Required Bearer token for `/mcp`. Omit to disable auth (not recommended). |

## Tools

| Tool | Description |
|------|-------------|
| `list_makes` | List all car makes available (Acura, BMW, Ford, Toyota, ...) |
| `browse_make` | Browse available years for a make (e.g. Ford → 1982–2013) |
| `browse_manuals` | Browse manuals at a specific path (e.g. `Ford/2010`) |
| `search_manuals` | Search for manuals by make + optional keyword/year |
| `get_manual_content` | Fetch the content of a specific charm.li page |

## Example Usage

```
list_makes
→ ["Acura", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", ...]

browse_make("Ford")
→ Years: 1982, 1983, ..., 2013

browse_manuals("Ford/2010")
→ Crown Victoria V8-4.6L, E 150 V8-4.6L, F 150 2WD V8-4.6L, ...

search_manuals("Ford", "2010 F-150")
→ F 150 2WD V8-4.6L, F 150 4WD V8-4.6L, ...

get_manual_content("https://charm.li/Ford/2010/Crown%20Victoria%20V8-4.6L/")
→ Repair and Diagnosis, Parts and Labor, Download .zip
```

## About Operation CHARM

[Operation CHARM](https://charm.li/about.html) is a community project providing free car service manuals for everyone. Manuals cover 1982–2013 model years across 50+ makes.

## License

MIT
