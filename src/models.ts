/**
 * Model catalog + provider adapters.
 *
 * Everything provider-specific lives here. The rest of the server speaks one
 * normalized request shape; this file translates it into each model's input
 * schema (which genuinely differs — `image_size` vs `resolution` vs `size`).
 *
 * Cloudflare-routed schemas verified against
 * developers.cloudflare.com/ai/models/<provider>/<model>/ on 2026-07-28.
 * Reve schema discovered by probing api.reve.com validation errors on the same
 * date (its reference docs sit behind the API console login).
 */

export const ASPECTS = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
] as const;
export type Aspect = (typeof ASPECTS)[number];

export const RESOLUTIONS = ["1K", "2K", "4K"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const TIERS = ["draft", "standard", "premium"] as const;
export type Tier = (typeof TIERS)[number];

export const PROVIDERS = ["auto", "google", "openai", "reve"] as const;
export type ProviderPref = (typeof PROVIDERS)[number];

export type OutputFormat = "png" | "jpg" | "webp";

export interface NormalizedRequest {
	prompt: string;
	aspect: Aspect;
	resolution: Resolution;
	transparent: boolean;
	format: OutputFormat;
	/** Reference images: https URLs or data:image/...;base64,... URIs. */
	refs: string[];
}

/** How the call reaches the model. */
export type Transport =
	/** Cloudflare unified catalog via `env.AI.run` (billed as Cloudflare credits). */
	| "gateway"
	/** Direct HTTPS to api.openai.com with OPENAI_API_KEY. */
	| "openai"
	/** Direct HTTPS to api.reve.com (Reve is not in Cloudflare's catalog). */
	| "reve";

export interface ModelSpec {
	id: string;
	transport: Transport;
	provider: "google" | "openai" | "reve";
	label: string;
	tier: Tier;
	/** Max reference images the provider accepts on an edit. 0 = text-to-image only. */
	maxRefs: number;
	/** Provider accepts https URLs as refs (otherwise base64 only). */
	refsAcceptUrls: boolean;
	transparentBackground: boolean;
	maxResolution: Resolution;
	/** One line on what this model is measurably good at. */
	bestFor: string;
	/** Where it loses to a sibling — the model should route away on these. */
	avoidFor: string;
	/** Independent standing, so routing is not just vibes. */
	arena: string;
	notes: string;
	buildInput(req: NormalizedRequest, tier?: Tier): Record<string, unknown>;
	estimateUsd(req: NormalizedRequest, tier?: Tier): number;
}

/**
 * Per-output-image list prices in USD.
 *
 * Cloudflare Unified Billing passes provider inference pricing through with no
 * markup (the 5% fee applies to credit *purchase*), so these approximate real
 * spend — but they are estimates: they exclude prompt/reference-image input
 * tokens, and this segment reprices roughly quarterly. Budget guardrail, not
 * an invoice. Ground truth: ai.google.dev/gemini-api/docs/pricing,
 * openai.com/api/pricing, app.reve.com/pricing.
 */
export const PRICING_NOTE =
	"Estimated from provider list prices (verified 2026-07); excludes input/prompt tokens. Not a billed amount.";

/** aspect -> the closest size gpt-image actually supports. */
function openaiSize(aspect: Aspect): "1024x1024" | "1024x1536" | "1536x1024" {
	const [w, h] = aspect.split(":").map(Number);
	const r = w / h;
	if (r > 1.15) return "1536x1024";
	if (r < 0.87) return "1024x1536";
	return "1024x1024";
}

function openaiQuality(tier: Tier): "low" | "medium" | "high" {
	return tier === "draft" ? "low" : tier === "standard" ? "medium" : "high";
}

/** gpt-image-2: square costs more than portrait/landscape at medium/high. */
function gptImage2Usd(tier: Tier, aspect: Aspect): number {
	const q = openaiQuality(tier);
	const square = openaiSize(aspect) === "1024x1024";
	if (q === "low") return 0.005;
	if (q === "medium") return square ? 0.053 : 0.041;
	return square ? 0.211 : 0.165;
}

/** Reve aspect ratios are a subset of ours. */
const REVE_ASPECTS = new Set(["16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "1:1"]);
function reveAspect(aspect: Aspect): string {
	if (REVE_ASPECTS.has(aspect)) return aspect;
	const [w, h] = aspect.split(":").map(Number);
	const r = w / h;
	if (r >= 1.7) return "16:9";
	if (r > 1.1) return "3:2";
	if (r <= 0.58) return "9:16";
	if (r < 0.9) return "2:3";
	return "1:1";
}

export const MODELS: Record<string, ModelSpec> = {
	// ---- Google (Cloudflare catalog) --------------------------------------
	"google/nano-banana-pro": {
		id: "google/nano-banana-pro",
		transport: "gateway",
		provider: "google",
		label: "Nano Banana Pro (gemini-3-pro-image)",
		tier: "premium",
		maxRefs: 3,
		refsAcceptUrls: true,
		transparentBackground: false,
		maxResolution: "4K",
		bestFor:
			"Native 4K, multi-subject realism, and edits that must preserve identity across references. The only model here that emits true 4K.",
		avoidFor:
			"Dense typography and precise layout control — Reve and GPT Image 2 both render text more reliably.",
		arena:
			"LMArena text-to-image #2 as Gemini 3 Pro Image, Elo ~1235 (Jul 2026).",
		notes: "Flagship. Native 4K. Uses `image_size`.",
		buildInput: (r) => ({
			prompt: r.prompt,
			aspect_ratio: r.aspect,
			image_size: r.resolution,
			output_format: r.format,
			...(r.refs.length ? { image_input: r.refs.slice(0, 3) } : {}),
		}),
		estimateUsd: (r) => (r.resolution === "4K" ? 0.24 : 0.134),
	},
	"google/nano-banana-2": {
		id: "google/nano-banana-2",
		transport: "gateway",
		provider: "google",
		label: "Nano Banana 2 (gemini-3.1-flash-image)",
		tier: "standard",
		maxRefs: 3,
		refsAcceptUrls: true,
		transparentBackground: false,
		maxResolution: "4K",
		bestFor:
			"The best default: multi-subject edits, high fidelity, search grounding for factual scenes, 1K-4K output.",
		avoidFor:
			"Long text blocks and exact typographic placement.",
		arena:
			"Ranked behind GPT Image 2 and Reve 2.0 on the Artificial Analysis Image Arena (Jul 2026).",
		notes: "Mid tier. Uses `resolution` (not `image_size`). Supports search grounding.",
		buildInput: (r) => ({
			prompt: r.prompt,
			aspect_ratio: r.aspect,
			resolution: r.resolution,
			output_format: r.format === "webp" ? "png" : r.format,
			...(r.refs.length ? { image_input: r.refs.slice(0, 3) } : {}),
		}),
		estimateUsd: (r) =>
			r.resolution === "4K" ? 0.15 : r.resolution === "2K" ? 0.1 : 0.045,
	},
	"google/nano-banana-2-lite": {
		id: "google/nano-banana-2-lite",
		transport: "gateway",
		provider: "google",
		label: "Nano Banana 2 Lite",
		tier: "draft",
		maxRefs: 3,
		refsAcceptUrls: true,
		transparentBackground: false,
		maxResolution: "2K",
		bestFor:
			"Cheap Google-family drafts that still accept up to 3 reference images.",
		avoidFor:
			"Final assets — quality is visibly below nano-banana-2.",
		arena:
			"Not separately ranked.",
		notes: "Cheapest Google tier.",
		buildInput: (r) => ({
			prompt: r.prompt,
			aspect_ratio: r.aspect,
			resolution: r.resolution,
			output_format: r.format === "webp" ? "png" : r.format,
			...(r.refs.length ? { image_input: r.refs.slice(0, 3) } : {}),
		}),
		estimateUsd: () => 0.034,
	},
	"google/imagen-4": {
		id: "google/imagen-4",
		transport: "gateway",
		provider: "google",
		label: "Imagen 4",
		tier: "draft",
		maxRefs: 0,
		refsAcceptUrls: false,
		transparentBackground: false,
		maxResolution: "2K",
		bestFor:
			"Bulk text-to-image at $0.02 when no reasoning or references are needed.",
		avoidFor:
			"Anything involving reference images, editing, or text in the image.",
		arena:
			"Ranked below the Gemini image family (Jul 2026).",
		notes: "Pure text-to-image, no multimodal reasoning. Cheap.",
		buildInput: (r) => ({ prompt: r.prompt, aspect_ratio: r.aspect }),
		estimateUsd: () => 0.02,
	},

	// ---- OpenAI (direct: api.openai.com with your own key) -----------------
	// Cloudflare's catalog carries gpt-image-2 and 1.5 too, but going direct
	// keeps the billing on your OpenAI account and unlocks gpt-image-1-mini,
	// which the catalog does not list. Set OPENAI_VIA_GATEWAY=true to route
	// these through env.AI.run instead.
	"openai/gpt-image-1-mini": {
		id: "openai/gpt-image-1-mini",
		transport: "openai",
		provider: "openai",
		label: "GPT Image 1 Mini",
		tier: "draft",
		maxRefs: 16,
		refsAcceptUrls: false,
		transparentBackground: true,
		maxResolution: "1K",
		bestFor:
			"Iteration and thumbnails at $0.005 — the right tool for exploring 20 compositions before committing.",
		avoidFor:
			"Final assets; fidelity is well below gpt-image-2.",
		arena:
			"Not separately ranked; inherits the GPT Image family's text-rendering strength.",
		notes:
			"Cheapest option anywhere: $0.005 at low quality. Direct-only — not in the Cloudflare catalog.",
		buildInput: (r, tier = "draft") => ({
			prompt: r.prompt,
			size: openaiSize(r.aspect),
			quality: openaiQuality(tier),
			output_format: r.format === "jpg" ? "jpeg" : r.format,
			...(r.transparent ? { background: "transparent" } : {}),
			...(r.refs.length ? { images: r.refs.slice(0, 16) } : {}),
		}),
		estimateUsd: (_r, tier = "draft") => {
			const q = openaiQuality(tier);
			return q === "low" ? 0.005 : q === "medium" ? 0.011 : 0.052;
		},
	},
	"openai/gpt-image-2": {
		id: "openai/gpt-image-2",
		transport: "openai",
		provider: "openai",
		label: "GPT Image 2",
		tier: "premium",
		maxRefs: 16,
		refsAcceptUrls: false, // base64 only
		transparentBackground: true,
		maxResolution: "1K", // caps at 1536px on the long edge
		bestFor:
			"Text rendering (best of any publicly ranked model, Latin and CJK), photorealism, and instruction following. Accepts up to 16 reference images.",
		avoidFor:
			"Anything above 1536px — it cannot emit 2K or 4K. Use Nano Banana Pro or Reve for that.",
		arena:
			"#1 on the Artificial Analysis Image Arena, Elo ~1339 from 13.3k blind comparisons, ~66-70 Elo clear of #2 — the largest first-to-second gap that board has recorded (Jul 2026).",
		notes:
			"Quality tier drives cost 40x ($0.005 low -> $0.211 high). Catalog copy claims no transparent background even though the schema exposes it — verify before relying on it.",
		buildInput: (r, tier = "premium") => ({
			prompt: r.prompt,
			size: openaiSize(r.aspect),
			quality: openaiQuality(tier),
			output_format: r.format === "jpg" ? "jpeg" : r.format,
			...(r.transparent ? { background: "transparent" } : {}),
			...(r.refs.length ? { images: r.refs.slice(0, 16) } : {}),
		}),
		estimateUsd: (r, tier = "premium") => gptImage2Usd(tier, r.aspect),
	},
	"openai/gpt-image-1.5": {
		id: "openai/gpt-image-1.5",
		transport: "openai",
		provider: "openai",
		label: "GPT Image 1.5",
		tier: "standard",
		maxRefs: 16,
		refsAcceptUrls: false,
		transparentBackground: false, // no `background` param in its schema
		maxResolution: "1K",
		bestFor:
			"A cheaper stand-in for gpt-image-2 with a `style` control (vivid/natural).",
		avoidFor:
			"Cases where gpt-image-2 quality matters; it is a generation behind.",
		arena:
			"LMArena text-to-image #1 at Elo ~1264 (Jul 2026) — note the boards disagree; Artificial Analysis puts gpt-image-2 well ahead.",
		notes: "Previous flagship. Has a `style` param; no `background` param.",
		buildInput: (r, tier = "standard") => {
			const s = openaiSize(r.aspect);
			return {
				prompt: r.prompt,
				size:
					s === "1536x1024"
						? "1792x1024"
						: s === "1024x1536"
							? "1024x1792"
							: "1024x1024",
				quality: openaiQuality(tier),
				...(r.refs.length ? { images: r.refs.slice(0, 16) } : {}),
			};
		},
		estimateUsd: (_r, tier = "standard") => {
			const q = openaiQuality(tier);
			return q === "low" ? 0.009 : q === "medium" ? 0.07 : 0.2;
		},
	},

	// ---- Reve (direct, NOT in the Cloudflare catalog) ----------------------
	"reve/v2": {
		id: "reve/v2",
		transport: "reve",
		provider: "reve",
		label: "Reve 2.1 (POST /v2/image/create)",
		tier: "premium",
		maxRefs: 0, // v2 create takes no reference images; edits live on v1
		refsAcceptUrls: false,
		transparentBackground: false,
		maxResolution: "4K", // Reve advertises native 4K on every generation
		bestFor:
			"Typography and layout: headlines, packaging, signage and posters come out legible and correctly positioned. Plans an editable layout first, then renders at native 4K.",
		avoidFor:
			"Multi-subject realism and any edit workflow — v2 accepts no reference images at all.",
		arena:
			"Reve 2.0 debuted #2 on the Arena behind GPT Image 2 and ahead of Nano Banana 2; 2.1 landed 9 Jul 2026, so independent testing is still thin.",
		notes:
			"Direct provider call, billed in Reve credits (separate from Cloudflare). v2 accepts only prompt/version/aspect_ratio — no seed, batch, or reference images. Observed cost: 150 credits/image (~$0.20 at the $10/7500 rate).",
		buildInput: (r) => ({
			prompt: r.prompt,
			aspect_ratio: reveAspect(r.aspect),
		}),
		estimateUsd: () => 0.2,
	},
	"reve/v1": {
		id: "reve/v1",
		transport: "reve",
		provider: "reve",
		label: "Reve v1 (POST /v1/image/create)",
		tier: "standard",
		maxRefs: 4, // via /v1/image/remix; /v1/image/edit takes exactly one
		refsAcceptUrls: false,
		transparentBackground: false,
		maxResolution: "2K",
		bestFor:
			"Reve's editing surface: /v1/image/edit takes one reference, /v1/image/remix takes several.",
		avoidFor:
			"Best quality — v2 supersedes it for generation.",
		arena:
			"Superseded by Reve 2.x on the leaderboards.",
		notes:
			"Legacy endpoint. Supported versions: reve-create@20250915, reve-create-alpha@20260115. This is the tier that can be materially cheaper than v2 — confirm your per-request credit cost.",
		buildInput: (r) => ({
			prompt: r.prompt,
			aspect_ratio: reveAspect(r.aspect),
		}),
		estimateUsd: () => 0.2,
	},
};

/**
 * Tier x provider -> model. `auto` picks the cheapest at draft and Google
 * above it: Nano Banana's multimodal reasoning and 2K/4K output beat gpt-image
 * at comparable price, and gpt-image caps at 1536px.
 */
const ROUTING: Record<Tier, Record<ProviderPref, string>> = {
	draft: {
		auto: "openai/gpt-image-1-mini", // $0.005 — the floor
		google: "google/nano-banana-2-lite",
		openai: "openai/gpt-image-1-mini",
		reve: "reve/v1",
	},
	standard: {
		auto: "google/nano-banana-2",
		google: "google/nano-banana-2",
		openai: "openai/gpt-image-2",
		reve: "reve/v1",
	},
	premium: {
		auto: "google/nano-banana-pro",
		google: "google/nano-banana-pro",
		openai: "openai/gpt-image-2",
		reve: "reve/v2",
	},
};

export interface Selection {
	model: ModelSpec;
	tier: Tier;
	req: NormalizedRequest;
	input: Record<string, unknown>;
	estimateUsd: number;
	warnings: string[];
}

export function selectModel(opts: {
	tier: Tier;
	provider: ProviderPref;
	model?: string;
	req: NormalizedRequest;
}): Selection {
	const warnings: string[] = [];
	const id = opts.model ?? ROUTING[opts.tier][opts.provider];
	const model = MODELS[id];
	if (!model) {
		throw new Error(
			`Unknown model "${id}". Call list_image_models for valid ids.`,
		);
	}

	const req = { ...opts.req };
	const order: Resolution[] = ["1K", "2K", "4K"];
	if (order.indexOf(req.resolution) > order.indexOf(model.maxResolution)) {
		warnings.push(
			`${model.label} maxes out at ${model.maxResolution}; ${req.resolution} was clamped.`,
		);
		req.resolution = model.maxResolution;
	}
	if (req.transparent && !model.transparentBackground) {
		warnings.push(
			`${model.label} has no transparent-background option; sent opaque.`,
		);
		req.transparent = false;
	}
	if (req.refs.length && model.maxRefs === 0) {
		warnings.push(
			`${model.label} accepts no reference images; ${req.refs.length} were dropped.`,
		);
		req.refs = [];
	} else if (req.refs.length > model.maxRefs) {
		warnings.push(
			`${model.label} accepts at most ${model.maxRefs} reference images; extras dropped.`,
		);
		req.refs = req.refs.slice(0, model.maxRefs);
	}

	return {
		model,
		tier: opts.tier,
		req,
		input: model.buildInput(req, opts.tier),
		estimateUsd: model.estimateUsd(req, opts.tier),
		warnings,
	};
}

const BLANK: NormalizedRequest = {
	prompt: "",
	aspect: "1:1",
	resolution: "1K",
	transparent: false,
	format: "png",
	refs: [],
};

export function catalog() {
	return Object.values(MODELS).map((m) => ({
		id: m.id,
		provider: m.provider,
		label: m.label,
		billed_via:
			m.transport === "gateway"
				? "cloudflare_credits"
				: m.transport === "openai"
					? "openai_account"
					: "reve_credits",
		default_tier: m.tier,
		max_resolution: m.maxResolution,
		supports_edit: m.maxRefs > 0,
		max_reference_images: m.maxRefs,
		transparent_background: m.transparentBackground,
		best_for: m.bestFor,
		avoid_for: m.avoidFor,
		independent_ranking: m.arena,
		estimated_usd_per_image: {
			"1K": m.estimateUsd({ ...BLANK, resolution: "1K" }, m.tier),
			"4K":
				m.maxResolution === "4K"
					? m.estimateUsd({ ...BLANK, resolution: "4K" }, m.tier)
					: null,
		},
		notes: m.notes,
	}));
}
