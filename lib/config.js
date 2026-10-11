/**
 * Plugin configuration: the schema the host validates against, the code-side
 * defaults (so a direct `apply()` call works without the loader), and the
 * normalisation of every knob.
 *
 * The Cordis loader applies `Config` defaults, but `apply` is also reachable
 * through direct construction (tests, tooling), so this module resolves its own
 * defaults instead of trusting the caller.
 *
 * @module dsh-ai-arcade/config
 */

import z from "@deepseek-ai/schemastery";

/** Reasoning efforts the DeepSeek adapter advertises. */
const EFFORTS = ["off", "low", "high", "max"];

/** Code-side defaults, mirrored by the `Config` schema below. */
export const DEFAULTS = Object.freeze({
	enabled: true,
	provider: "deepseek-account",
	model: "deepseek-flash",
	// Measured on this box: at the host default (high) a game-sized prompt spends
	// the whole output budget on the reasoning block and returns an EMPTY text
	// block after ~9s; at `low` the same prompt answers in ~1-2s with text.
	reasoningEffort: "low",
	maxTokens: 2048,
	timeoutMs: 45_000,
	temperature: 0.7,
	maxBodyBytes: 65_536,
	// Not a feature: changing this string is what makes the loader re-read this
	// plugin row, which is how a host-half edit (and the client bundle served
	// from it) is picked up without restarting DSH. `tools/dev-sync.sh` bumps it.
	devStamp: "",
});

export const Config = z.object({
	/** Master switch; `false` registers no HTTP route and spends no credits. */
	enabled: z.boolean().default(DEFAULTS.enabled),
	/** Provider id for the game brain (empty = auto-pick the first usable one). */
	provider: z.string().default(DEFAULTS.provider),
	/** Model id for the game brain. */
	model: z.string().default(DEFAULTS.model),
	/** Reasoning budget per brain call: `off`, `low`, `high` or `max`. */
	reasoningEffort: z.string().default(DEFAULTS.reasoningEffort),
	/** Output cap per brain call. */
	maxTokens: z.natural().default(DEFAULTS.maxTokens),
	/** Hard ceiling on one brain call; the UI shows a timeout instead of hanging. */
	timeoutMs: z.natural().default(DEFAULTS.timeoutMs),
	/** Sampling temperature — higher makes the opponent more erratic/characterful. */
	temperature: z.number().default(DEFAULTS.temperature),
	/** Request body cap for the brain route. */
	maxBodyBytes: z.natural().default(DEFAULTS.maxBodyBytes),
	/** Development reload trigger; see {@link DEFAULTS.devStamp}. */
	devStamp: z.string().default(DEFAULTS.devStamp),
});

/**
 * One of `allowed`, or `fallback` when the value is absent/unknown.
 *
 * @param value - raw configured value.
 * @param allowed - accepted strings.
 * @param fallback - value used otherwise.
 * @returns the resolved string.
 */
function pick(value, allowed, fallback) {
	return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

/**
 * A finite number clamped into `[min, max]`, or `fallback`.
 *
 * @param value - raw configured value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used otherwise.
 * @returns the resolved number.
 */
function clampNumber(value, min, max, fallback) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, number));
}

/**
 * A positive integer, or `fallback`.
 *
 * @param value - raw configured value.
 * @param fallback - value used otherwise.
 * @returns the resolved integer.
 */
function positiveInteger(value, fallback) {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/**
 * Resolve user configuration into the plain settings object the plugin uses.
 *
 * @param raw - the loader-supplied config (possibly undefined).
 * @returns resolved settings.
 */
export function resolveConfig(raw) {
	const config = raw === null || typeof raw !== "object" ? {} : raw;
	return {
		enabled: config.enabled !== false,
		provider: typeof config.provider === "string" ? config.provider.trim() : DEFAULTS.provider,
		model: typeof config.model === "string" ? config.model.trim() : DEFAULTS.model,
		reasoningEffort: pick(config.reasoningEffort, EFFORTS, DEFAULTS.reasoningEffort),
		maxTokens: positiveInteger(config.maxTokens, DEFAULTS.maxTokens),
		timeoutMs: positiveInteger(config.timeoutMs, DEFAULTS.timeoutMs),
		temperature: clampNumber(config.temperature, 0, 2, DEFAULTS.temperature),
		maxBodyBytes: positiveInteger(config.maxBodyBytes, DEFAULTS.maxBodyBytes),
		devStamp: typeof config.devStamp === "string" ? config.devStamp : DEFAULTS.devStamp,
	};
}
