# OpenTAO MCP

Read-only Model Context Protocol server for the Bittensor "Start mining" surface.
Any MCP client (Claude Desktop/Code, Cursor, …) can query subnet economics,
playbooks, setup steps, and get subnet recommendations.

Backed by `https://opentao.ai/mining-data.json` — same source as the website, so
the agent and the site never diverge. **No write actions**: anything that costs
TAO/GPU is returned as text for the operator to run and confirm.

## Tools
`list_subnets` · `get_subnet` · `get_playbook` · `get_setup_guide` ·
`recommend_subnets` · `get_resources`

## Dev / deploy
```sh
bun install
bunx wrangler dev            # local, /mcp (streamable HTTP) + /sse
bunx wrangler deploy         # needs Cloudflare auth
```

## Connect (after deploy)
- Claude Code: `claude mcp add --transport http opentao https://opentao-mcp.<acct>.workers.dev/mcp`
- Endpoint: `/mcp` (streamable HTTP, recommended) or `/sse` (legacy)
