/**
 * 贪吃蛇的"策略卡"层：把模型的一段自由文本变成一张可执行的卡片。
 *
 * 传输本身在 `llm.js`（与游戏无关），这里只管贪吃蛇特有的那部分：人格设定、
 * 提示词、以及**宽松解析**。解析必须宽松——模型偶尔会多写一句话、包一层代码
 * 块、或把数字写成字符串；解析失败时调用方退回本地策略，而不是让游戏卡住。
 *
 * @module src/client/brain
 */

import { askBrain } from "./llm.js";
import { DEFAULT_POLICY, describeBoard } from "./games/snake.js";

/** 可选人格：让两条蛇"性格"不同，观赏性和可玩性都更好。 */
export const PERSONAS = Object.freeze({
	steady: { label: "稳健", brief: "先保命再吃食物，绝不冒险钻进狭窄的死角。" },
	greedy: { label: "贪婪", brief: "看到食物就冲，愿意为多吃一口冒险。" },
	sly: { label: "阴险", brief: "喜欢卡住对手的去路，宁可自己少吃也要堵死对方。" },
	showman: { label: "戏精", brief: "打法花哨，台词要多，喜欢绕圈羞辱对手。" },
});

/** 策略卡允许的取值。 */
const TARGETS = new Set(["food", "center", "block"]);

/**
 * 抽取第一个**括号平衡**的 JSON 对象。
 *
 * 不用正则匹配 `{...}`：模型有时会在字符串里写花括号，平衡扫描才不会截断。
 *
 * @param text - 模型的原始回复。
 * @returns JSON 子串，找不到时返回 null。
 */
function firstJsonObject(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * @param value - 字段原值。
 * @param fallback - 不可用时用的值。
 * @returns 夹在 `[0, 1]` 内的数字。
 */
function unit(value, fallback) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(1, Math.max(0, number));
}

/**
 * 把一段模型回复解析成 `{ policy, taunt }`。
 *
 * 永不抛错：识别不出卡片时返回 `null`，调用方继续用上一张卡。
 *
 * @param text - 模型的原始回复。
 * @returns 解析出的策略卡与剩下那句台词，或 null。
 */
export function parsePolicy(text) {
	if (typeof text !== "string" || text.trim() === "") return null;
	const json = firstJsonObject(text);
	if (json === null) return null;
	let raw;
	try {
		raw = JSON.parse(json);
	} catch {
		// 常见毛病：单引号、尾随逗号。修一轮再试，失败就放弃。
		try {
			raw = JSON.parse(json.replace(/'/g, '"').replace(/,\s*}/g, "}"));
		} catch {
			return null;
		}
	}
	if (raw === null || typeof raw !== "object") return null;
	const target = typeof raw.target === "string" && TARGETS.has(raw.target.trim().toLowerCase())
		? raw.target.trim().toLowerCase()
		: DEFAULT_POLICY.target;
	const taunt = text.replace(json, "").replace(/[`*\s]+/g, " ").trim();
	return {
		policy: {
			target,
			aggression: unit(raw.aggression, DEFAULT_POLICY.aggression),
			risk: unit(raw.risk, DEFAULT_POLICY.risk),
			reason: typeof raw.reason === "string" ? raw.reason.slice(0, 120) : "",
			taunt: taunt.slice(0, 60),
		},
		taunt,
	};
}

/**
 * 组一次策略请求。
 *
 * 卡片刻意做小：`off` 档一次回复约 30 个输出 token，而且模型只需要表达**意图**
 * ——具体走法由引擎翻译，所以一张草率的卡也变不出非法走法。
 *
 * @param game - 游戏状态。
 * @param snake - 被问的那条蛇。
 * @param personaKey - {@link PERSONAS} 的键。
 * @returns 提示词。
 */
export function buildPolicyPrompt(game, snake, personaKey) {
	const persona = PERSONAS[personaKey] ?? PERSONAS.steady;
	return [
		`你是「双脑贪吃蛇」里控制「${snake.label}」的 AI，正在和另一条蛇对战。`,
		`你的性格：${persona.label}——${persona.brief}`,
		"",
		describeBoard(game, snake),
		"",
		"给出一张策略卡（JSON）和一句不超过 20 字的挑衅，格式严格如下，只输出这一行：",
		'{"target":"food","aggression":0.7,"risk":0.3} 你这条短蛇就等着看我吃吧',
		"target 只能是 food(抢食物) / center(占中路) / block(堵对手)；aggression 和 risk 是 0~1 的小数。",
		"不要输出解释、不要用代码块。",
	].join("\n");
}

/**
 * 问一次策略卡。
 *
 * @param options - `game`、`snake`、`personaKey`、`signal`、`onDelta`、`onThought`。
 * @returns `{ ok, policy, taunt, text, elapsedMs }` 或 `{ ok: false, error }`。
 */
export async function askPolicy(options) {
	const { game, snake, personaKey, signal, onDelta, onThought } = options;
	const result = await askBrain({
		prompt: buildPolicyPrompt(game, snake, personaKey),
		signal,
		onDelta,
		onThought,
	});
	if (!result.ok) return result;
	const parsed = parsePolicy(result.text);
	if (parsed === null) {
		return { ok: false, error: "模型没有给出可解析的策略卡", text: result.text, elapsedMs: result.elapsedMs };
	}
	return {
		ok: true,
		policy: parsed.policy,
		taunt: parsed.taunt,
		text: result.text,
		elapsedMs: result.elapsedMs,
	};
}
