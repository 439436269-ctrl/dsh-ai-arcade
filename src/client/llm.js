/**
 * 与宿主 LLM 路由之间的客户端通道（游戏无关）。
 *
 * 浏览器半边拿不到 `ctx.llm`（宿主包只在主进程里解析得到），所以一切模型调用
 * 都走同源 HTTP：`POST /api/dsh-ai-arcade/brain`，Server-Sent Events 回来。
 * 凭据不落浏览器，这是刻意的。
 *
 * 这里只做"发请求 + 拼增量文本"，**不认识任何游戏**——策略卡解析在 snake 那边，
 * 象棋解说在象棋那边。这样每个游戏都能用它，而不用把对方的东西拖进来。
 *
 * @module src/client/llm
 */

/** 宿主半边注册的同源路由。 */
export const BRAIN_ROUTE = "/api/dsh-ai-arcade/brain";

/**
 * 解析一个 `event:`/`data:` 的 SSE 帧。
 *
 * @param frame - 不含结尾空行的原始帧文本。
 * @returns 事件名与解析后的负载；不可用时返回 null。
 */
function parseFrame(frame) {
	let event = "message";
	const dataLines = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return null;
	try {
		return { event, data: JSON.parse(dataLines.join("\n")) };
	} catch {
		return { event, data: { message: dataLines.join("\n") } };
	}
}

/**
 * 发一次流式请求。
 *
 * @param options - `prompt`、可选 `system`、`signal`，以及两个流式回调
 *   （`onDelta` 收正文，`onThought` 收思考块）。
 * @returns `{ ok, text, reasoning, elapsedMs }` 或 `{ ok: false, error }`。
 */
export async function askBrain(options) {
	const { prompt, system, signal, onDelta, onThought } = options;
	const started = Date.now();
	try {
		const response = await fetch(BRAIN_ROUTE, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify(system === undefined ? { prompt } : { prompt, system }),
			signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			return { ok: false, error: `HTTP ${response.status} ${response.statusText} ${detail.slice(0, 200)}` };
		}
		if (response.body === null) return { ok: false, error: "响应没有可读的流" };

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let text = "";
		let reasoning = "";
		let failure = null;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let cut = buffer.indexOf("\n\n");
			while (cut >= 0) {
				const parsed = parseFrame(buffer.slice(0, cut));
				buffer = buffer.slice(cut + 2);
				cut = buffer.indexOf("\n\n");
				if (parsed === null) continue;
				if (parsed.event === "thinking") {
					const piece = parsed.data.text ?? "";
					reasoning += piece;
					if (typeof onThought === "function") onThought(piece);
				} else if (parsed.event === "delta") {
					const piece = parsed.data.text ?? "";
					text += piece;
					if (typeof onDelta === "function") onDelta(piece);
				} else if (parsed.event === "done") {
					if (typeof parsed.data.text === "string" && parsed.data.text.length > text.length) text = parsed.data.text;
				} else if (parsed.event === "error") {
					failure = `${parsed.data.code ?? "error"}: ${parsed.data.message ?? ""}`;
				}
			}
		}
		if (failure !== null && text === "") return { ok: false, error: failure };
		return { ok: true, text, reasoning, elapsedMs: Date.now() - started };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return { ok: false, aborted: true, error: "aborted" };
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
