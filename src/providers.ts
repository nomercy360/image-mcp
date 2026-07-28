/**
 * Invocation layer: turns a Selection into bytes-on-disk (R2) + a URL.
 *
 * Two transports:
 *  - "gateway": env.AI.run against Cloudflare's unified catalog. Cloudflare
 *    holds the provider credentials and deducts from your account credits
 *    (BYOK is explicitly NOT supported through the AI binding).
 *  - "reve":    direct HTTPS to api.reve.com with your own bearer token.
 */

import { DEFAULT_REVE_USD_PER_CREDIT, type Selection } from "./models";
import type { Env } from "./env";

export interface ImageResult {
	/** Stable URL served by this Worker (or the upstream URL if R2 is off). */
	url: string;
	/** R2 object key, when persisted. */
	key?: string;
	contentType: string;
	bytes?: number;
	model: string;
	estimatedUsd: number;
	/** What the provider says it charged, when it says so. Beats the estimate. */
	actualUsd?: number;
	/** Raw provider accounting, passed through for transparency. */
	usage?: Record<string, number>;
	warnings: string[];
	/** Anything the provider told us that we did not model. */
	raw?: unknown;
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

function mimeFor(format: string): string {
	return MIME[format] ?? "image/png";
}

/** Pull an image URL or base64 payload out of whatever shape came back. */
function extractImage(payload: unknown): { url?: string; b64?: string } {
	const seen = new Set<unknown>();
	const walk = (node: unknown, depth: number): { url?: string; b64?: string } => {
		if (!node || depth > 5 || seen.has(node)) return {};
		if (typeof node === "string") {
			if (node.startsWith("http://") || node.startsWith("https://")) {
				return { url: node };
			}
			if (node.startsWith("data:image/")) {
				return { b64: node.slice(node.indexOf(",") + 1) };
			}
			// Bare base64 payloads are long and alphabet-restricted.
			if (node.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(node)) {
				return { b64: node };
			}
			return {};
		}
		if (typeof node !== "object") return {};
		seen.add(node);
		if (Array.isArray(node)) {
			for (const item of node) {
				const hit = walk(item, depth + 1);
				if (hit.url || hit.b64) return hit;
			}
			return {};
		}
		const obj = node as Record<string, unknown>;
		// Check the known key names first so we do not grab a stray URL.
		for (const k of ["image", "b64_json", "url", "image_url", "images", "data", "result", "output"]) {
			if (k in obj) {
				const hit = walk(obj[k], depth + 1);
				if (hit.url || hit.b64) return hit;
			}
		}
		for (const v of Object.values(obj)) {
			const hit = walk(v, depth + 1);
			if (hit.url || hit.b64) return hit;
		}
		return {};
	};
	return walk(payload, 0);
}

async function runGateway(
	env: Env,
	sel: Selection,
	cacheKey: string,
): Promise<{ payload: unknown }> {
	if (!env.AI) {
		throw new Error(
			`The AI binding is not available, so ${sel.model.id} cannot be reached. ` +
				"You are probably running `npm run dev:local`, which omits it deliberately " +
				"(the binding only runs against Cloudflare's edge). Run `npx wrangler login` " +
				"then `npm run dev`, or use provider:\"reve\" which calls the provider directly.",
		);
	}
	const gatewayId = env.AI_GATEWAY_ID || "default";
	const cacheTtl = Number(env.CACHE_TTL_SECONDS ?? "300");
	// Caching is the idempotency guard: an agent that retries after a timeout
	// re-reads the cached image instead of paying for a second generation.
	const payload = await (env.AI as unknown as {
		run: (m: string, i: unknown, o?: unknown) => Promise<unknown>;
	}).run(sel.model.id, sel.input, {
		gateway: {
			id: gatewayId,
			cacheKey,
			...(cacheTtl > 0 ? { cacheTtl } : { skipCache: true }),
			metadata: { source: "image-mcp", tier: sel.tier },
		},
	});
	return { payload };
}

/** Turn a data: URI or https URL into a Blob for multipart uploads. */
async function toBlob(ref: string, index: number): Promise<{ blob: Blob; name: string }> {
	if (ref.startsWith("data:")) {
		const [meta, b64] = ref.split(",", 2);
		const type = meta.slice(5, meta.indexOf(";")) || "image/png";
		const bin = atob(b64);
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		const ext = type.split("/")[1] ?? "png";
		return { blob: new Blob([arr], { type }), name: `ref-${index}.${ext}` };
	}
	const res = await fetch(ref);
	if (!res.ok) throw new Error(`Could not fetch reference image ${ref} (${res.status})`);
	const type = res.headers.get("content-type") ?? "image/png";
	const ext = type.split("/")[1]?.split(";")[0] ?? "png";
	return { blob: await res.blob(), name: `ref-${index}.${ext}` };
}

/**
 * Direct api.openai.com. The gateway input builder already emits OpenAI-native
 * parameter names, so the same `sel.input` works on both paths — only the
 * `images` array has to move from JSON into multipart form fields.
 */
async function runOpenAI(env: Env, sel: Selection): Promise<{ payload: unknown }> {
	if (!env.OPENAI_API_KEY) {
		throw new Error(
			"OPENAI_API_KEY is not set. Add it to .dev.vars locally or `wrangler secret put OPENAI_API_KEY` for deploys.",
		);
	}
	const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
	const model = sel.model.id.split("/")[1];
	const { images, ...rest } = sel.input as { images?: string[] } & Record<string, unknown>;
	const editing = Array.isArray(images) && images.length > 0;

	let res: Response;
	if (editing) {
		const form = new FormData();
		form.set("model", model);
		for (const [k, v] of Object.entries(rest)) form.set(k, String(v));
		let i = 0;
		for (const ref of images!) {
			const { blob, name } = await toBlob(ref, i++);
			form.append("image[]", blob, name);
		}
		res = await fetch(`${base}/v1/images/edits`, {
			method: "POST",
			headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
			body: form,
		});
	} else {
		res = await fetch(`${base}/v1/images/generations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({ model, ...rest }),
		});
	}

	const text = await res.text();
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		payload = text;
	}
	if (!res.ok) {
		const err = (payload as { error?: { message?: string; code?: string } })?.error;
		throw new Error(
			`OpenAI ${editing ? "edits" : "generations"} failed (${res.status}${
				err?.code ? ` ${err.code}` : ""
			}): ${err?.message ?? text.slice(0, 300)}`,
		);
	}
	return { payload };
}

async function runReve(
	env: Env,
	sel: Selection,
): Promise<{ payload: unknown }> {
	if (!env.REVE_API_KEY) {
		throw new Error(
			"REVE_API_KEY is not set. Add it to .dev.vars locally or `wrangler secret put REVE_API_KEY` for deploys.",
		);
	}
	const base = (env.REVE_BASE_URL ?? "https://api.reve.com").replace(/\/$/, "");
	const path = sel.model.id === "reve/v2" ? "/v2/image/create" : "/v1/image/create";
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${env.REVE_API_KEY}`,
		},
		body: JSON.stringify(sel.input),
	});
	const text = await res.text();
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		payload = text;
	}
	if (!res.ok) {
		const err = payload as { error_code?: string; message?: string };
		throw new Error(
			`Reve ${path} failed (${res.status} ${err?.error_code ?? ""}): ${
				err?.message ?? text.slice(0, 300)
			}`,
		);
	}
	return { payload };
}

/** Persist to R2 so the URL we hand back outlives the provider's own link. */
async function persist(
	env: Env,
	body: ArrayBuffer,
	contentType: string,
	ext: string,
	requestUrl: string,
): Promise<{ url: string; key: string }> {
	const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
	await env.BUCKET!.put(key, body, {
		httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
	});
	const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? new URL(requestUrl).origin;
	return { url: `${base}/i/${key}`, key };
}

/**
 * Downscaled base64 preview so the model can actually look at the result.
 *
 * Cost is quadratic in edge length: an image costs roughly (w*h)/750 tokens,
 * so 512px is ~350 tokens where the 1024px original is ~1,400 — and ~500,000
 * if it were handed back as raw base64 text instead of an image block.
 * Full resolution always stays one fetch away at the returned URL.
 */
export async function preview(
	env: Env,
	source: { key?: string; url: string },
	maxPx: number,
): Promise<{ data: string; mimeType: string } | { error: string }> {
	if (!env.IMAGES) {
		return {
			error:
				"No Images binding, so the preview could not be downscaled. Add `\"images\": { \"binding\": \"IMAGES\" }` to wrangler.jsonc.",
		};
	}

	// Prefer R2 directly — no point round-tripping through our own HTTP route.
	let body: ReadableStream<Uint8Array> | null = null;
	if (source.key && env.BUCKET) {
		body = (await env.BUCKET.get(source.key))?.body ?? null;
	}
	if (!body) {
		const res = await fetch(source.url);
		if (!res.ok) return { error: `Could not read image for preview (${res.status}).` };
		body = res.body;
	}
	if (!body) return { error: "Image had no body to preview." };

	try {
		// width alone preserves aspect ratio, and width/height/format are the
		// options wrangler dev's offline Images mode supports.
		const out = await env.IMAGES.input(body)
			.transform({ width: maxPx })
			// WebP, not JPEG: it keeps alpha (transparent-background images would
			// otherwise flatten to black) and is smaller at equal quality.
			.output({ format: "image/webp", quality: 75 });
		const encoded = await new Response(out.image({ encoding: "base64" })).text();
		return { data: encoded, mimeType: out.contentType() };
	} catch (err) {
		return { error: `Preview transform failed: ${(err as Error).message}` };
	}
}

export async function generate(
	env: Env,
	sel: Selection,
	opts: { cacheKey: string; requestUrl: string },
): Promise<ImageResult> {
	// OpenAI models can go either way; direct keeps billing on your OpenAI
	// account, the gateway keeps it on Cloudflare credits with shared caching.
	let transport = sel.model.transport;
	if (
		transport === "openai" &&
		env.OPENAI_VIA_GATEWAY === "true" &&
		// gpt-image-1-mini is not in Cloudflare's catalog, so it has no gateway route.
		sel.model.id !== "openai/gpt-image-1-mini"
	) {
		transport = "gateway";
	}

	const { payload } =
		transport === "gateway"
			? await runGateway(env, sel, opts.cacheKey)
			: transport === "openai"
				? await runOpenAI(env, sel)
				: await runReve(env, sel);

	const warnings = [...sel.warnings];

	// Cloudflare surfaces a lifecycle state; anything but Completed means we do
	// not have bytes yet (async/queued jobs are opt-in, so this is unexpected).
	const state = (payload as { state?: string } | null)?.state;
	if (state && state !== "Completed") {
		throw new Error(
			`Provider returned state "${state}" instead of Completed. Raw: ${JSON.stringify(payload).slice(0, 400)}`,
		);
	}

	// Reve reports exact credit usage; prefer it over our price table.
	let actualUsd: number | undefined;
	let usage: Record<string, number> | undefined;
	const acct = payload as { credits_used?: number; credits_remaining?: number } | null;
	if (acct && typeof acct.credits_used === "number") {
		const rate = Number(env.REVE_USD_PER_CREDIT ?? "") || DEFAULT_REVE_USD_PER_CREDIT;
		actualUsd = acct.credits_used * rate;
		usage = {
			credits_used: acct.credits_used,
			usd_per_credit: rate,
			...(typeof acct.credits_remaining === "number"
				? { credits_remaining: acct.credits_remaining }
				: {}),
		};
	}

	const { url, b64 } = extractImage(payload);
	if (!url && !b64) {
		throw new Error(
			`Could not find an image in the provider response. Keys: ${JSON.stringify(
				payload && typeof payload === "object" ? Object.keys(payload) : payload,
			).slice(0, 300)}`,
		);
	}

	const ext = sel.req.format === "jpg" ? "jpg" : sel.req.format;
	const contentType = mimeFor(ext);

	// No R2 binding: hand back the provider URL untouched (base64 has nowhere
	// to go, so that combination is a hard error rather than a 2MB token bill).
	if (!env.BUCKET) {
		if (!url) {
			throw new Error(
				"Provider returned base64 but no R2 bucket is bound. Bind IMAGES in wrangler.jsonc so the bytes have somewhere to live.",
			);
		}
		warnings.push(
			"No R2 bucket bound — returning the provider's own URL, which may expire.",
		);
		return {
			url,
			contentType,
			model: sel.model.id,
			estimatedUsd: sel.estimateUsd,
			actualUsd,
			usage,
			warnings,
		};
	}

	let body: ArrayBuffer;
	if (b64) {
		const bin = atob(b64.replace(/\s/g, ""));
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		body = arr.buffer;
	} else {
		const res = await fetch(url!);
		if (!res.ok) {
			throw new Error(`Failed to download generated image (${res.status}) from ${url}`);
		}
		body = await res.arrayBuffer();
	}

	const stored = await persist(env, body, contentType, ext, opts.requestUrl);
	return {
		url: stored.url,
		key: stored.key,
		contentType,
		bytes: body.byteLength,
		model: sel.model.id,
		estimatedUsd: sel.estimateUsd,
		actualUsd,
		usage,
		warnings,
	};
}
