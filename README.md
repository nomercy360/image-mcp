# image-mcp

An MCP server on Cloudflare Workers that gives Claude image generation across
**Google (Nano Banana)**, **OpenAI (GPT Image)** and **Reve** behind one set of
tools — with a hard spend cap, cost reporting on every call, and URLs instead of
megabytes of base64.

Works with Claude Code, Claude Desktop and claude.ai (Custom Connectors) over the
same streamable-HTTP endpoint.

## Why it is shaped this way

**It returns URLs, not bytes.** Both provider families hand back base64. A
1024×1024 PNG is ~1.4 MB, ~1.9 MB as base64, roughly 500k tokens if you pass it
back as text — well past `MAX_MCP_OUTPUT_TOKENS` (25k default). Images are
persisted to R2 and the tool returns `{url, model, estimated_cost_usd, budget}`.
Pass `return_inline: true` when Claude actually needs to *look* at the result.

**Three tiers, not one tool per model.** `draft | standard | premium` maps to
model ids internally. Cost across those tiers varies 40×, so the tool
descriptions carry arena rankings and per-model strengths, and
`list_image_models` returns the whole table — routing policy lives in data, not
in your system prompt.

**A budget counter, not a prompt.** Agents call image tools in loops. A Durable
Object tracks daily estimated spend, reserves before each call and refunds on
failure. Over the cap the tool returns an error instead of an image.

**Retries do not double-pay.** Identical requests are cached (gateway `cacheKey`
for catalog models) for `CACHE_TTL_SECONDS`. Pass `variation` to force a re-roll.

## Models

| Model | Route | Max res | Edits | ~$/image | Notes |
|---|---|---|---|---|---|
| `openai/gpt-image-1-mini` | direct | 1024px | 16 refs | 0.005–0.052 | The floor. Not in Cloudflare's catalog. |
| `openai/gpt-image-2` | direct | 1536px | 16 refs | 0.005–0.211 | #1 Artificial Analysis Image Arena (~1339 Elo, Jul 2026). Best text rendering. |
| `openai/gpt-image-1.5` | direct | 1792px | 16 refs | 0.009–0.20 | Previous flagship, has `style`. |
| `google/nano-banana-pro` | gateway | 4K | 3 refs | 0.134 / 0.24 (4K) | Native 4K, multi-subject realism. |
| `google/nano-banana-2` | gateway | 4K | 3 refs | 0.045–0.15 | Best all-round default. |
| `google/nano-banana-2-lite` | gateway | 2K | 3 refs | 0.034 | Cheap Google drafts. |
| `google/imagen-4` | gateway | 2K | — | 0.02 | Bulk text-to-image. |
| `reve/v2` | direct | 4K | — | ~0.20 | Layout-first: typography, packaging, posters. |
| `reve/v1` | direct | 2K | 4 refs | ~0.20 | Reve's editing surface. |

Prices are provider list prices verified July 2026, excluding prompt/input
tokens. They drive the budget guardrail; they are not invoices.

## Billing paths

Three separate accounts get charged depending on the model:

- **`gateway`** — `env.AI.run` against Cloudflare's unified catalog. Cloudflare
  holds the provider keys and deducts your Cloudflare credits. BYOK is *not*
  supported through the AI binding. Unified Billing charges a 5% fee on credit
  purchases; inference itself is passed through at provider rates.
- **`openai`** — direct to `api.openai.com` with your own key. Set
  `OPENAI_VIA_GATEWAY=true` to move these onto the gateway instead.
- **`reve`** — direct to `api.reve.com`. Reve is not in Cloudflare's catalog.
  v2 costs 150 credits/image (~$0.20 at the $10/7,500 rate).

Hosting itself is cheap: the Workers Paid plan is $5/mo for 10M requests and 30M
CPU-ms; Durable Objects with the SQLite backend run on the free plan too. The
image spend is the real cost and is entirely separate.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # add your keys
npm run dev:local                # no Cloudflare account needed
```

`dev:local` uses `wrangler.local.jsonc`, which omits the `ai` binding — that
binding only runs against Cloudflare's edge and forces `wrangler dev` into
remote mode (and a login) just to boot. In this mode the OpenAI and Reve models
work fully; `google/*` returns a clear error. For the Google models:

```bash
npx wrangler login
npm run dev                      # full config, AI binding live
```

Smoke test:

```bash
curl -s localhost:8787/health
curl -s -X POST localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer <MCP_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Behind a TLS-intercepting proxy

`workerd` ships its own CA bundle and ignores `NODE_EXTRA_CA_CERTS`, so on a
network running Netskope/Zscaler every outbound HTTPS fetch from a local Worker
fails with an opaque `internal error`. Run the relay in a second terminal:

```bash
npm run relay
```

and point the providers at it in `.dev.vars`:

```
OPENAI_BASE_URL="http://localhost:8788/openai"
REVE_BASE_URL="http://localhost:8788/reve"
```

Deployed Workers call providers from Cloudflare's edge, so none of this applies
in production.

## Deploy

```bash
npx wrangler r2 bucket create image-mcp-images
npx wrangler secret put MCP_TOKEN        # any long random string
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put REVE_API_KEY
npm run deploy
```

## Connect it

**Claude Code**

```bash
claude mcp add --transport http imggen https://<worker>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

**claude.ai / Desktop** — Settings → Connectors → Add custom connector → paste
`https://<worker>.workers.dev/mcp`, then put `Authorization: Bearer <MCP_TOKEN>`
under Advanced → Request headers.

Auth is a static bearer token, checked with a constant-time compare. That is the
right shape for a single-tenant server: the OAuth path (401 +
`WWW-Authenticate: Bearer resource_metadata=…`) would require standing up a full
authorization server, and Anthropic does not support pure machine-to-machine
`client_credentials` anyway — every connection needs user consent.

## Tools

| Tool | What it does |
|---|---|
| `generate_image` | Text → image. `tier`, `provider`, `aspect`, `resolution`, `format`, `transparent`, `variation`, `return_inline`. |
| `edit_image` | Image(s) + instruction → image. Accepts https URLs or `data:` URIs. |
| `list_image_models` | Full catalog: cost, ranking, limits, what each model is best and worst at. |
| `get_image_budget` | Today's spend against the cap. |

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `MCP_TOKEN` | — | Bearer token clients must send. Unset = open server. |
| `OPENAI_API_KEY` | — | Enables the OpenAI models. |
| `REVE_API_KEY` | — | Enables the Reve models. |
| `DAILY_BUDGET_USD` | `5` | Hard daily cap on estimated spend. |
| `CACHE_TTL_SECONDS` | `300` | Gateway cache TTL / retry-dedupe window. |
| `AI_GATEWAY_ID` | `default` | AI Gateway name for catalog models. |
| `OPENAI_VIA_GATEWAY` | — | `"true"` routes OpenAI through Cloudflare instead. |
| `PUBLIC_BASE_URL` | request origin | Origin used to build returned image URLs. |

## Verified / unverified

Verified live on 2026-07-28: MCP protocol negotiation (2025-11-25), tool
listing, `generate_image` and `edit_image` end-to-end against
`gpt-image-1-mini`, R2 persistence, image serving, budget reserve/refund, and
the Reve endpoint schema (probed from its validation errors — its reference docs
sit behind the API console login).

Not yet exercised: the `gateway` transport (needs a Cloudflare account with
credits) and the Reve generation response shape (the supplied key had zero
budget — `PARTNER_API_BUDGET_EXHAUSTED`). The Reve response parser is
deliberately tolerant of `image` / `b64_json` / `data[].url` shapes and reports
the payload keys if none match.
