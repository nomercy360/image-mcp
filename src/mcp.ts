/**
 * MCP surface: four tools, provider-agnostic.
 *
 * Deliberately NOT one tool per model — Claude picks a tier and an optional
 * provider, and list_image_models tells it what each costs so the routing
 * policy lives in data rather than in a prompt.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	ASPECTS,
	PRICING_NOTE,
	PROVIDERS,
	RESOLUTIONS,
	TIERS,
	catalog,
	selectModel,
	type Aspect,
	type NormalizedRequest,
	type OutputFormat,
	type ProviderPref,
	type Resolution,
	type Tier,
} from "./models";
import { generate } from "./providers";
import { budgetStub } from "./budget";
import type { Env } from "./env";

const RESULT_SHAPE = {
	url: z.string(),
	model: z.string(),
	estimated_cost_usd: z.number(),
	pricing_note: z.string(),
	budget: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
	warnings: z.array(z.string()),
};

async function digest(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(buf)]
		.slice(0, 12)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

interface RunArgs {
	prompt: string;
	tier: Tier;
	provider: ProviderPref;
	model?: string;
	aspect: Aspect;
	resolution: Resolution;
	format: OutputFormat;
	transparent: boolean;
	refs: string[];
	variation?: string;
	return_inline: boolean;
}

/** Tool errors must reach the model as text, not as an opaque runtime fault. */
async function guarded<T>(fn: () => Promise<T>) {
	try {
		return await fn();
	} catch (err) {
		const e = err as Error;
		console.error("image-mcp tool failure:", e?.stack ?? e);
		return {
			isError: true as const,
			content: [{ type: "text" as const, text: `Image generation failed: ${e?.message ?? String(err)}` }],
		};
	}
}

async function run(env: Env, requestUrl: string, args: RunArgs) {
	const req: NormalizedRequest = {
		prompt: args.prompt,
		aspect: args.aspect,
		resolution: args.resolution,
		transparent: args.transparent,
		format: args.format,
		refs: args.refs,
	};
	const sel = selectModel({
		tier: args.tier,
		provider: args.provider,
		model: args.model,
		req,
	});

	const limit = Number(env.DAILY_BUDGET_USD ?? "5");
	const budget = budgetStub(env);
	const reservation = await budget.reserve(sel.estimateUsd, limit);
	if (!reservation.ok) {
		return {
			isError: true as const,
			content: [
				{
					type: "text" as const,
					text:
						`Daily image budget exhausted. Spent $${reservation.spent_usd} of $${reservation.limit_usd}; ` +
						`this ${sel.model.id} call would take it to $${reservation.would_be}. ` +
						`Raise DAILY_BUDGET_USD or wait for the UTC day to roll over.`,
				},
			],
		};
	}

	let result: Awaited<ReturnType<typeof generate>>;
	try {
		const cacheKey = await digest(
			JSON.stringify([sel.model.id, sel.input, args.variation ?? ""]),
		);
		result = await generate(env, sel, { cacheKey, requestUrl });
	} catch (err) {
		await budget.refund(sel.estimateUsd);
		throw err;
	}

	const structured = {
		url: result.url,
		model: result.model,
		estimated_cost_usd: result.estimatedUsd,
		pricing_note: PRICING_NOTE,
		budget: {
			spent_today_usd: reservation.spent_usd,
			limit_usd: reservation.limit_usd,
			remaining_usd: reservation.remaining_usd,
		},
		warnings: result.warnings,
	};

	const content: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	> = [{ type: "text", text: JSON.stringify(structured, null, 2) }];

	// Inline bytes are opt-in: a 1024px PNG is ~1.4MB, ~500k tokens as base64,
	// which blows past MAX_MCP_OUTPUT_TOKENS. The URL is the default payload.
	if (args.return_inline) {
		const res = await fetch(result.url);
		const buf = await res.arrayBuffer();
		if (buf.byteLength > 1_500_000) {
			structured.warnings.push(
				`Image is ${(buf.byteLength / 1e6).toFixed(1)}MB — too large to inline; returning the URL only.`,
			);
		} else {
			let bin = "";
			const bytes = new Uint8Array(buf);
			for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
			content.push({
				type: "image",
				data: btoa(bin),
				mimeType: result.contentType,
			});
		}
	}

	return { content, structuredContent: structured };
}

export function createServer(env: Env, requestUrl: string): McpServer {
	const server = new McpServer({ name: "image-mcp", version: "0.1.0" });

	server.registerTool(
		"generate_image",
		{
			title: "Generate image",
			description:
				"Generate an image from a text prompt. Returns a URL, not image bytes.\n\n" +
				"Choose `tier` by how much the image matters — draft (~$0.005) to explore compositions, " +
				"standard (~$0.04-0.10) for most work, premium (~$0.13-0.24) for final assets and 4K. " +
				"Cost varies 40x across tiers, so do not default to premium.\n\n" +
				"Choose `provider` by what the image has to do (rankings as of July 2026):\n" +
				"- text in the image, signage, UI mockups, photorealism -> openai (GPT Image 2 is #1 on the " +
				"Artificial Analysis Image Arena at ~1339 Elo, ~66-70 clear of #2, with the best Latin and CJK " +
				"text rendering of any ranked model). Capped at 1536px.\n" +
				"- typography-led layout: posters, packaging, headlines -> reve (plans an editable layout, then " +
				"renders native 4K; debuted #2 on the Arena).\n" +
				"- multi-subject realism, 2K/4K output, or edits that must keep a subject's identity -> google " +
				"(Nano Banana). Only Google and Reve emit true 4K.\n" +
				"- no strong preference -> auto.\n\n" +
				"Call list_image_models for exact per-model cost, ranking and limits.",
			inputSchema: z.object({
				prompt: z.string().min(1).max(4000),
				tier: z.enum(TIERS).default("standard"),
				provider: z
					.enum(PROVIDERS)
					.default("auto")
					.describe("auto picks the best value for the tier"),
				model: z
					.string()
					.optional()
					.describe("Exact model id, overrides tier/provider routing"),
				aspect: z.enum(ASPECTS).default("1:1"),
				resolution: z
					.enum(RESOLUTIONS)
					.default("1K")
					.describe("Clamped to what the chosen model supports"),
				format: z.enum(["png", "jpg", "webp"]).default("png"),
				transparent: z.boolean().default(false),
				variation: z
					.string()
					.optional()
					.describe(
						"Change this to force a fresh generation; identical calls are served from cache to avoid double-paying on retries",
					),
				return_inline: z
					.boolean()
					.default(false)
					.describe("Also return the image bytes so you can look at the result. Expensive — URL only by default."),
			}),
			outputSchema: z.object(RESULT_SHAPE),
		},
		async (args) =>
			guarded(() => run(env, requestUrl, { ...args, refs: [] })) as never,
	);

	server.registerTool(
		"edit_image",
		{
			title: "Edit image",
			description:
				"Edit or remix existing images with a text instruction. Pass https URLs or " +
				"data:image/...;base64,... URIs (OpenAI needs base64; it fetches URLs for you either way).\n\n" +
				"Reference limits: OpenAI 16, Google 3, Reve v1 4, Reve v2 none. For edits that must preserve a " +
				"subject's identity across references, google (Nano Banana) is the strongest; for edits that " +
				"change or add text in the image, openai is.",
			inputSchema: z.object({
				prompt: z.string().min(1).max(4000).describe("The edit instruction"),
				images: z
					.array(z.string())
					.min(1)
					.max(16)
					.describe("https URLs or data:image/...;base64,... URIs"),
				tier: z.enum(TIERS).default("standard"),
				provider: z.enum(PROVIDERS).default("auto"),
				model: z.string().optional(),
				aspect: z.enum(ASPECTS).default("1:1"),
				resolution: z.enum(RESOLUTIONS).default("1K"),
				format: z.enum(["png", "jpg", "webp"]).default("png"),
				transparent: z.boolean().default(false),
				variation: z.string().optional(),
				return_inline: z.boolean().default(false),
			}),
			outputSchema: z.object(RESULT_SHAPE),
		},
		async ({ images, ...args }) =>
			guarded(() => run(env, requestUrl, { ...args, refs: images })) as never,
	);

	server.registerTool(
		"list_image_models",
		{
			title: "List image models",
			description:
				"Every available model with estimated per-image cost, max resolution, edit support, independent " +
				"arena ranking, what each is best and worst at, and which account it bills against. " +
				"Read this before picking a model for anything cost- or quality-sensitive.",
			inputSchema: z.object({}),
		},
		async () => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{ pricing_note: PRICING_NOTE, models: catalog() },
						null,
						2,
					),
				},
			],
		}),
	);

	server.registerTool(
		"get_image_budget",
		{
			title: "Get image budget",
			description: "Today's estimated image spend against the configured daily cap.",
			inputSchema: z.object({}),
		},
		async () => {
			const limit = Number(env.DAILY_BUDGET_USD ?? "5");
			const status = await budgetStub(env).status(limit);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ ...status, pricing_note: PRICING_NOTE }, null, 2),
					},
				],
			};
		},
	);

	return server;
}
