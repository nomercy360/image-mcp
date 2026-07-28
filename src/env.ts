export interface Env {
	/** Workers AI binding — also the door to the third-party unified catalog. */
	AI: unknown;
	/** Optional: where generated images are persisted. */
	BUCKET?: R2Bucket;
	/** Optional: Cloudflare Images, used only to downscale inline previews. */
	IMAGES?: ImagesBinding;
	/** Budget counter (Durable Object, SQLite backend). */
	BUDGET: DurableObjectNamespace;

	/** Shared bearer token clients must present. Unset = open server. */
	MCP_TOKEN?: string;
	/** AI Gateway name; "default" auto-creates. */
	AI_GATEWAY_ID?: string;
	/** OpenAI API key (direct provider path — billing stays on your OpenAI account). */
	OPENAI_API_KEY?: string;
	/** "true" routes OpenAI models through env.AI.run instead of api.openai.com. */
	OPENAI_VIA_GATEWAY?: string;
	/** Override api.openai.com — used by the dev egress relay. */
	OPENAI_BASE_URL?: string;
	/** Override api.reve.com — used by the dev egress relay. */
	REVE_BASE_URL?: string;
	/** Reve partner API token (direct provider path). */
	REVE_API_KEY?: string;
	/** Hard daily spend ceiling in USD, enforced before each call. */
	DAILY_BUDGET_USD?: string;
	/** Gateway cache TTL; doubles as the retry/idempotency window. */
	CACHE_TTL_SECONDS?: string;
	/** Origin used to build returned image URLs (defaults to the request origin). */
	PUBLIC_BASE_URL?: string;
}
