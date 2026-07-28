/**
 * Daily spend ceiling.
 *
 * The failure mode this exists for: an agent calls generate_image in a loop
 * during a long task. A prompt-level "please be frugal" does not stop that; a
 * counter does. A Durable Object gives single-threaded read-modify-write, so
 * concurrent tool calls cannot both slip under the limit.
 *
 * Reserve before spending, refund if the provider call fails.
 */

import { DurableObject } from "cloudflare:workers";

interface State {
	day: string;
	spentUsd: number;
	calls: number;
}

const EMPTY: State = { day: "", spentUsd: 0, calls: 0 };

export class BudgetTracker extends DurableObject {
	private async read(): Promise<State> {
		const s = (await this.ctx.storage.get<State>("state")) ?? EMPTY;
		const today = new Date().toISOString().slice(0, 10);
		return s.day === today ? s : { day: today, spentUsd: 0, calls: 0 };
	}

	async status(limitUsd: number) {
		const s = await this.read();
		return {
			day: s.day || new Date().toISOString().slice(0, 10),
			spent_usd: Number(s.spentUsd.toFixed(4)),
			calls: s.calls,
			limit_usd: limitUsd,
			remaining_usd: Number(Math.max(0, limitUsd - s.spentUsd).toFixed(4)),
		};
	}

	/** Returns false (without charging) when the request would breach the cap. */
	async reserve(usd: number, limitUsd: number) {
		const s = await this.read();
		if (s.spentUsd + usd > limitUsd) {
			return {
				ok: false as const,
				spent_usd: Number(s.spentUsd.toFixed(4)),
				limit_usd: limitUsd,
				would_be: Number((s.spentUsd + usd).toFixed(4)),
			};
		}
		const next: State = { day: s.day, spentUsd: s.spentUsd + usd, calls: s.calls + 1 };
		await this.ctx.storage.put("state", next);
		return {
			ok: true as const,
			spent_usd: Number(next.spentUsd.toFixed(4)),
			limit_usd: limitUsd,
			remaining_usd: Number(Math.max(0, limitUsd - next.spentUsd).toFixed(4)),
		};
	}

	async refund(usd: number) {
		const s = await this.read();
		const next: State = {
			day: s.day,
			spentUsd: Math.max(0, s.spentUsd - usd),
			calls: Math.max(0, s.calls - 1),
		};
		await this.ctx.storage.put("state", next);
	}
}

export function budgetStub(env: { BUDGET: DurableObjectNamespace }) {
	// One counter for the whole server; shard by user id here if you add auth.
	return env.BUDGET.get(env.BUDGET.idFromName("global")) as unknown as BudgetTracker;
}
