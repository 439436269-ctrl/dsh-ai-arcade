/**
 * The brain seam — the only place this plugin talks to a model.
 *
 * Three responsibilities, kept out of the route so all of them stay testable:
 *   1. resolve a usable `{ provider, model }` (configured value first, then the
 *      first advertised pair — so the plugin still works on a profile that has
 *      never heard of `deepseek-account`);
 *   2. drive one `ctx.llm.stream()` call and hand back assembled text, pushing
 *      each incremental piece to the caller so the browser can render the model
 *      thinking in real time;
 *   3. keep the reasoning budget honest. The host defaults `reasoningEffort` to
 *      the model's declared default (high for the DeepSeek models on this box),
 *      and at that effort a game-sized answer can spend the entire output budget
 *      on the reasoning block and return an EMPTY text block — a "successful"
 *      call that says nothing. This plugin therefore asks for `low` by default
 *      and retries once without the knob if the model does not support it.
 *
 * Everything else model-shaped is the harness's job (credentials, adapters,
 * retry, JSON mode) — the same seam `dsh-shift-router` uses for its Judge.
 *
 * @module dsh-ai-arcade/brain
 */

import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

/** The opponent's standing character. Per-game tactics come in as the prompt. */
export const BRAIN_SYSTEM = [
	"你是「双脑贪吃蛇」里的 AI 玩家，控制右边那条蛇；玩家控制左边那条蛇。",
	"你说话干脆、带一点自信的垃圾话，但每次不超过两句。",
	"回答用中文，不要输出 JSON、不要用 Markdown 代码块。",
].join("\n");

/** Reasoning efforts the DeepSeek adapter advertises. `""` means "do not ask". */
export const REASONING_EFFORTS = Object.freeze(["off", "low", "high", "max"]);

/**
 * Split an assembled call into its spoken text and its private reasoning.
 *
 * Both are returned: the game panel shows the reply as the answer and the
 * reasoning as a dimmer "thinking" trace, which is exactly the "watch it think"
 * affordance this plugin is built around.
 *
 * @param assembler - the live block assembler.
 * @returns the concatenated `text` and `reasoning` blocks so far.
 */
function blocksOf(assembler) {
	try {
		let text = "";
		let reasoning = "";
		for (const block of assembler.blocks()) {
			if (typeof block?.text !== "string") continue;
			if (block.type === "text") text += block.text;
			else if (block.type === "reasoning") reasoning += block.text;
		}
		return { text, reasoning };
	} catch {
		return { text: "", reasoning: "" };
	}
}

/**
 * A short human-readable reason from an adapter failure.
 *
 * @param failure - the failure carried by the assembler's finish state.
 * @returns a message suitable for the game panel.
 */
function describeFailure(failure) {
	if (failure === null || typeof failure !== "object") return "model call failed";
	const message = failure.message ?? failure.code ?? failure.kind;
	return typeof message === "string" && message !== "" ? message : "model call failed";
}

/**
 * Resolve the provider/model pair this plugin should call.
 *
 * @param ctx - host plugin context (needs the `llm` service).
 * @param settings - resolved plugin settings.
 * @returns the pair, or null when the host advertises no usable model.
 */
export async function resolveTarget(ctx, settings) {
	const provider = settings.provider;
	const model = settings.model;
	if (provider !== "" && model !== "") {
		try {
			await ctx.llm.resolveModelInfo(provider, model);
			return { provider, model, source: "config" };
		} catch {
			// Fall through to discovery: a profile without this provider is not an error.
		}
	}
	try {
		const providers = ctx.llm.listProviders() ?? [];
		for (const entry of providers) {
			const id = typeof entry === "string" ? entry : entry?.id;
			if (typeof id !== "string" || id === "") continue;
			const models = await ctx.llm.listModels(id);
			if (!Array.isArray(models)) continue;
			const first = models.find((candidate) => typeof candidate === "string" && candidate !== "");
			if (first !== undefined) return { provider: id, model: first, source: "auto" };
		}
	} catch {
		// No discovery either — report the absence instead of guessing.
	}
	return null;
}

/**
 * Drive one streamed brain call.
 *
 * @param ctx - host plugin context.
 * @param options - system/prompt text, resolved target, caps, abort signal, an
 *   `onDelta` callback for spoken text and an `onThought` callback for reasoning.
 * @returns `{ ok: true, text, reasoning, usage }` or
 *   `{ ok: false, text, reasoning, code, detail }`.
 */
export async function streamBrain(ctx, options) {
	const { system, prompt, provider, model, maxTokens, temperature, reasoningEffort, signal, onDelta, onThought } =
		options;

	/**
	 * One attempt, with or without an explicit reasoning effort.
	 *
	 * @param effort - `""` to leave the choice to the host.
	 * @returns the attempt outcome.
	 */
	const attempt = async (effort) => {
		const assembler = new BlockAssembler();
		let sentText = "";
		let sentThought = "";

		/** Forward whatever incremental content arrived since the last call. */
		const flush = () => {
			const now = blocksOf(assembler);
			if (now.text.length > sentText.length) {
				const delta = now.text.slice(sentText.length);
				sentText = now.text;
				if (typeof onDelta === "function") onDelta(delta);
			}
			if (now.reasoning.length > sentThought.length) {
				const delta = now.reasoning.slice(sentThought.length);
				sentThought = now.reasoning;
				if (typeof onThought === "function") onThought(delta);
			}
		};

		const config = {
			provider,
			model,
			system,
			messages: [
				createUserMessage({
					content: [{ type: "text", text: prompt }],
					source: { kind: "user" },
				}),
			],
			temperature,
			maxTokens,
			signal,
		};
		if (typeof effort === "string" && effort !== "") config.reasoningEffort = effort;

		const stream = ctx.llm.stream(config);
		for await (const chunk of stream) {
			assembler.push(chunk);
			flush();
		}
		const finish = assembler.finish;
		flush();

		const blocks = blocksOf(assembler);
		const usage = typeof assembler.usage === "object" ? assembler.usage : undefined;
		if (finish !== undefined && finish !== null && (finish.kind === "error" || finish.kind === "aborted")) {
			return {
				ok: false,
				text: blocks.text,
				reasoning: blocks.reasoning,
				code: finish.kind,
				detail: describeFailure(finish.failure),
				...(usage === undefined ? {} : { usage }),
			};
		}
		return {
			ok: true,
			text: blocks.text,
			reasoning: blocks.reasoning,
			...(usage === undefined ? {} : { usage }),
		};
	};

	try {
		return await attempt(reasoningEffort);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// A model that advertises no reasoning support rejects the knob outright;
		// the call itself is still fine, so retry once without it.
		if (typeof reasoningEffort === "string" && reasoningEffort !== "" && /reasoning/i.test(detail)) {
			try {
				return await attempt("");
			} catch (retryError) {
				return {
					ok: false,
					text: "",
					reasoning: "",
					code: "stream-failed",
					detail: retryError instanceof Error ? retryError.message : String(retryError),
				};
			}
		}
		return { ok: false, text: "", reasoning: "", code: "stream-failed", detail };
	}
}
