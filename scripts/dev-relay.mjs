/**
 * Dev-only egress relay.
 *
 * workerd (the runtime behind `wrangler dev`) ships its own CA bundle and does
 * not read NODE_EXTRA_CA_CERTS, so on a network with TLS interception —
 * Netskope, Zscaler, most corporate proxies — every outbound HTTPS fetch from
 * a local Worker dies with an opaque "internal error".
 *
 * This relay accepts plain HTTP from the Worker and re-issues the request from
 * Node, which does trust the system keychain. Point the provider base URLs at
 * it in .dev.vars:
 *
 *   OPENAI_BASE_URL="http://localhost:8788/openai"
 *   REVE_BASE_URL="http://localhost:8788/reve"
 *
 * Deployed Workers call the providers directly from Cloudflare's edge, so none
 * of this exists in production.
 */
import http from "node:http";

const TARGETS = {
	openai: "https://api.openai.com",
	reve: "https://api.reve.com",
};
const PORT = Number(process.env.RELAY_PORT ?? 8788);

http
	.createServer(async (req, res) => {
		if (req.url === "/health") {
			res.writeHead(200);
			return res.end("relay ok");
		}
		const [, name, ...rest] = req.url.split("/");
		const base = TARGETS[name];
		if (!base) {
			res.writeHead(404);
			return res.end(`unknown target "${name}"; known: ${Object.keys(TARGETS).join(", ")}`);
		}
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const headers = { ...req.headers };
		delete headers.host;
		delete headers["content-length"];
		try {
			const upstream = await fetch(`${base}/${rest.join("/")}`, {
				method: req.method,
				headers,
				body: chunks.length ? Buffer.concat(chunks) : undefined,
			});
			const buf = Buffer.from(await upstream.arrayBuffer());
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json",
			});
			res.end(buf);
		} catch (e) {
			res.writeHead(502);
			res.end(JSON.stringify({ relay_error: String(e) }));
		}
	})
	.listen(PORT, () => console.log(`egress relay on http://localhost:${PORT}`));
