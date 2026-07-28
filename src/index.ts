/**
 * Worker entry.
 *
 *   POST /mcp   streamable-HTTP MCP endpoint (bearer-authenticated)
 *   GET  /i/*   serves persisted images from R2 (unauthenticated by design —
 *               the key is a UUID, and Claude/your browser must be able to
 *               fetch the URL without credentials)
 *   GET  /      health + connection instructions
 */

import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp";
import type { Env } from "./env";

export { BudgetTracker } from "./budget";

const MCP_ROUTE = "/mcp";

/**
 * Shared-secret auth. Deliberately NOT the OAuth 401 + WWW-Authenticate dance:
 * emitting `WWW-Authenticate: Bearer resource_metadata=...` makes Claude start
 * a full OAuth discovery flow, which needs an authorization server. For a
 * single-tenant server a static header is the right shape.
 */
function authorized(request: Request, env: Env): boolean {
	if (!env.MCP_TOKEN) return true; // unset = open (fine for local dev only)
	const header = request.headers.get("authorization") ?? "";
	const token = header.replace(/^Bearer\s+/i, "");
	if (token.length !== env.MCP_TOKEN.length) return false;
	// Constant-time-ish compare so the token cannot be guessed byte by byte.
	let diff = 0;
	for (let i = 0; i < token.length; i++) {
		diff |= token.charCodeAt(i) ^ env.MCP_TOKEN.charCodeAt(i);
	}
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/i/")) {
			if (!env.BUCKET) return new Response("No image bucket bound", { status: 404 });
			const object = await env.BUCKET.get(decodeURIComponent(url.pathname.slice(3)));
			if (!object) return new Response("Not found", { status: 404 });
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set("etag", object.httpEtag);
			return new Response(object.body, { headers });
		}

		if (url.pathname === "/" || url.pathname === "/health") {
			return Response.json({
				ok: true,
				name: "image-mcp",
				mcp_endpoint: new URL(MCP_ROUTE, url.origin).toString(),
				auth: env.MCP_TOKEN ? "Authorization: Bearer <MCP_TOKEN>" : "none (MCP_TOKEN unset)",
				r2: Boolean(env.BUCKET),
				reve: Boolean(env.REVE_API_KEY),
				daily_budget_usd: Number(env.DAILY_BUDGET_USD ?? "5"),
			});
		}

		if (url.pathname === MCP_ROUTE && !authorized(request, env)) {
			return Response.json(
				{ error: "unauthorized", detail: "Send Authorization: Bearer <MCP_TOKEN>." },
				{ status: 401 },
			);
		}

		const handler = createMcpHandler(() => createServer(env, request.url), {
			route: MCP_ROUTE,
		});
		return handler(request, env, ctx);
	},
};
