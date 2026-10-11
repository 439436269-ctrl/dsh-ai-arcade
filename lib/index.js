/**
 * dsh-ai-arcade — host half.
 *
 * One read-only-by-nature HTTP route that turns a game situation into one
 * streamed model reply. The browser half (declared through `package.json` →
 * `dsh.client`, `platform: "web"`) owns the 60fps game loop and never talks to
 * a model directly — it cannot, because the browser bundle has no access to the
 * host's `llm` service.
 *
 * The split is deliberate: credentials and provider adapters stay in the host
 * process, the game stays in the browser, and a slow model can never stall a
 * frame.
 *
 * @module dsh-ai-arcade
 */

import { BRAIN_SYSTEM, resolveTarget, streamBrain } from "./brain.js";
import { Config, resolveConfig } from "./config.js";
import { registerPlayRoute } from "./play.js";
import { isTrustedRequest } from "./trust.js";

export const name = "ai-arcade";

export const inject = ["llm", "webServer"];

export { Config };

/** Exact path served by this plugin. */
export const BRAIN_ROUTE = "/api/dsh-ai-arcade/brain";

/** Headers that keep proxies (and `dsh-pocket`'s reverse proxy) from buffering a stream. */
const SSE_HEADERS = Object.freeze({
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
	"x-accel-buffering": "no",
});

/**
 * Write one JSON envelope (used for every non-streaming answer).
 *
 * @param res - HTTP response.
 * @param status - status code.
 * @param body - JSON-serialisable body.
 */
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/**
 * Read and parse a JSON request body, refusing anything over the cap.
 *
 * @param req - HTTP request.
 * @param limitBytes - maximum accepted body size.
 * @returns the parsed object.
 */
function readJsonBody(req, limitBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limitBytes) {
				reject(new Error(`request body exceeds ${limitBytes} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

/**
 * Answer one brain request as a Server-Sent Events stream.
 *
 * Events: `start` (resolved model), `delta` (incremental text), `done`
 * (full text + elapsed), `error` (`code`, `message`). The stream is the
 * contract the game panel renders against, so a failure is always an `error`
 * event rather than a dropped connection.
 *
 * @param ctx - host plugin context.
 * @param settings - resolved plugin settings.
 * @param trustedHosts - authorities from the web runtime.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleBrain(ctx, settings, trustedHosts, req, res) {
	if (!isTrustedRequest(req, trustedHosts)) {
		writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
		return;
	}

	let payload;
	if (req.method === "POST") {
		try {
			payload = await readJsonBody(req, settings.maxBodyBytes);
		} catch (error) {
			writeJson(res, 400, {
				ok: false,
				error: { code: "bad-body", message: error instanceof Error ? error.message : "malformed body" },
			});
			return;
		}
	} else {
		let params;
		try {
			params = new URL(req.url ?? BRAIN_ROUTE, "http://localhost").searchParams;
		} catch {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "malformed request url" } });
			return;
		}
		payload = { prompt: params.get("prompt") ?? "", system: params.get("system") ?? undefined };
	}

	const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
	if (prompt === "") {
		writeJson(res, 400, { ok: false, error: { code: "empty-prompt", message: "prompt is required" } });
		return;
	}
	const system = typeof payload?.system === "string" && payload.system.trim() !== "" ? payload.system : BRAIN_SYSTEM;

	res.writeHead(200, SSE_HEADERS);
	res.flushHeaders?.();

	const controller = new AbortController();
	const onClientGone = () => controller.abort();
	res.on("close", onClientGone);
	const timer = setTimeout(() => controller.abort(), settings.timeoutMs);

	/**
	 * Write one SSE frame; a write after the client vanished is not an error.
	 *
	 * @param event - event name.
	 * @param data - JSON-serialisable payload.
	 */
	const send = (event, data) => {
		try {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		} catch {
			// Client disappeared mid-write; the close handler already aborted the call.
		}
	};

	try {
		const target = await resolveTarget(ctx, settings);
		if (target === null) {
			send("error", {
				code: "no-model",
				message: "no usable provider/model is registered in this harness",
			});
			return;
		}
		send("start", {
			provider: target.provider,
			model: target.model,
			source: target.source,
			reasoningEffort: settings.reasoningEffort,
		});

		const started = Date.now();
		const result = await streamBrain(ctx, {
			system,
			prompt,
			provider: target.provider,
			model: target.model,
			reasoningEffort: settings.reasoningEffort,
			maxTokens: settings.maxTokens,
			temperature: settings.temperature,
			signal: controller.signal,
			onDelta: (text) => send("delta", { text }),
			onThought: (text) => send("thinking", { text }),
		});
		const elapsedMs = Date.now() - started;

		if (result.ok) {
			send("done", {
				text: result.text,
				reasoningChars: typeof result.reasoning === "string" ? result.reasoning.length : 0,
				elapsedMs,
				provider: target.provider,
				model: target.model,
				...(result.usage === undefined ? {} : { usage: result.usage }),
			});
		} else {
			send("error", {
				code: result.code,
				message: result.detail,
				...(typeof result.reasoning === "string" && result.reasoning !== ""
					? { reasoningChars: result.reasoning.length }
					: {}),
				elapsedMs,
			});
		}
	} catch (error) {
		send("error", {
			code: "handler-crashed",
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		clearTimeout(timer);
		res.off("close", onClientGone);
		res.end();
	}
}

/**
 * Register the brain route.
 *
 * @param ctx - host plugin context.
 * @param settings - resolved plugin settings.
 * @returns a disposer (no-op when the host has no web server).
 */
export function registerBrainRoute(ctx, settings) {
	const server = ctx.get("webServer");
	if (server === undefined || typeof server.register !== "function") {
		console.warn("[dsh-ai-arcade] no webServer service — brain route not registered");
		return () => {};
	}
	const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
	const dispose = server.register({
		kind: "exact",
		path: BRAIN_ROUTE,
		handler: (req, res) => handleBrain(ctx, settings, trustedHosts, req, res),
	});
	console.log(
		`[dsh-ai-arcade] brain route ready at ${BRAIN_ROUTE} (${settings.provider}/${settings.model}, effort ${settings.reasoningEffort})`
	);
	return () => {
		if (typeof dispose === "function") dispose();
	};
}

/**
 * Mount the plugin.
 *
 * @param ctx - host plugin context.
 * @param config - loader config (defaults are re-resolved here).
 */
export function apply(ctx, config) {
	const settings = resolveConfig(config);
	if (!settings.enabled) {
		console.log("[dsh-ai-arcade] disabled by configuration");
		return;
	}
	ctx.effect(() => registerBrainRoute(ctx, settings), "dsh-ai-arcade: brain route");
	// The game itself lives on its own same-origin page (served `no-store`) so it
	// stays editable without restarting DSH; the overlay panel only frames it.
	ctx.effect(() => registerPlayRoute(ctx), "dsh-ai-arcade: play route");
}
