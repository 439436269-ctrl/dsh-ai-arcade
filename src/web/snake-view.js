/**
 * 双脑贪吃蛇的界面。
 *
 * 从原来的单游戏 `app.js` 搬过来，改成"挂进一个容器、返回卸载函数"的形状，好让
 * 外壳在多个游戏之间切换。玩法逻辑没变：模型只出**策略卡**（1.7 秒一次、后台
 * 异步），每一步由本地引擎按卡走，所以模型慢或挂了游戏照样跑。
 *
 * @module src/web/snake-view
 */

import { PERSONAS, askPolicy } from "../client/brain.js";
import { createGame, step } from "../client/games/snake.js";
import { paintBoard } from "../client/render.js";

/** 四种节奏。 */
const SPEEDS = [
	{ label: "慢", ms: 300 },
	{ label: "中", ms: 190 },
	{ label: "快", ms: 120 },
	{ label: "极快", ms: 75 },
];

const MODES = [
	{ id: "step", label: "单步", hint: "点「让 AI 出招」让模型重新决策，或用「走一步」按当前策略走" },
	{ id: "live", label: "实时对战", hint: "两条蛇自动对弈，模型在后台异步刷新策略" },
	{ id: "play", label: "我来玩", hint: "方向键 / WASD 操控蓝蛇，空格单步" },
];

/** 后台刷新策略的间隔（毫秒）。远慢于 tick —— 这就是"实时"能成立的原因。 */
const POLICY_INTERVAL_MS = 1700;

const KEY_DIRS = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	w: "up",
	s: "down",
	a: "left",
	d: "right",
	W: "up",
	S: "down",
	A: "left",
	D: "right",
};

const TEMPLATE = `
<div class="wrap">
  <div class="left">
    <div class="head">
      <span class="title">双脑贪吃蛇</span>
      <div class="seg" id="modes"></div>
      <label class="speed">速度 <input type="range" id="speed" min="0" max="3" step="1" value="1"><span id="speedLabel">中</span></label>
    </div>
    <canvas id="board"></canvas>
    <div class="row">
      <button class="act" id="ask">让 AI 出招</button>
      <button class="act" id="one">走一步</button>
      <button class="ghost" id="pause">⏸ 暂停</button>
      <button class="ghost" id="restart">重新开始</button>
      <span class="meta" id="hint"></span>
    </div>
    <div class="meta" id="meta"></div>
  </div>
  <aside class="side">
    <div class="score" id="score"></div>
    <div class="brains" id="brains"></div>
    <div class="stream" id="stream"></div>
  </aside>
</div>
`;

/**
 * 挂载贪吃蛇界面。
 *
 * @param container - 承载界面的元素（外壳已清空）。
 * @returns 卸载函数。
 */
export function mount(container) {
	container.innerHTML = TEMPLATE;

	/**
	 * @param id - element id inside the view.
	 * @returns the element.
	 */
	const el = (id) => {
		const node = container.querySelector(`#${id}`);
		if (node === null) throw new Error(`missing element #${id}`);
		return node;
	};

	const dom = {
		board: el("board"),
		modes: el("modes"),
		speed: el("speed"),
		speedLabel: el("speedLabel"),
		ask: el("ask"),
		one: el("one"),
		pause: el("pause"),
		restart: el("restart"),
		hint: el("hint"),
		meta: el("meta"),
		score: el("score"),
		brains: el("brains"),
		stream: el("stream"),
	};

	const state = {
		mode: "live",
		speed: 1,
		paused: false,
		game: createGame(),
		personas: { you: "sly", ai: "greedy" },
		busy: { you: false, ai: false },
		notes: { you: "", ai: "" },
		meta: "",
		inFlight: { you: false, ai: false },
		controllers: { you: null, ai: null },
	};

	/** 走一格。 */
	function moveOne() {
		if (state.game.over) return;
		step(state.game);
		renderSide();
	}

	/** 右侧（分数 + 两张大脑卡 + 流式文本）。 */
	function renderSide() {
		const [blue, yellow] = state.game.snakes;
		dom.score.innerHTML =
			`<span>${blue.label}</span><b>${blue.score}</b><span>:</span><b>${yellow.score}</b><span>${yellow.label}</span>`;

		dom.brains.innerHTML = "";
		for (const snake of [blue, yellow]) {
			const personaKey = state.personas[snake.id] ?? "steady";
			const busied = state.busy[snake.id];
			const dotClass = `dot${!snake.alive ? " dead" : busied ? " busy" : ""}`;
			const options = Object.entries(PERSONAS)
				.map(([id, entry]) => `<option value="${id}"${id === personaKey ? " selected" : ""}>${entry.label}</option>`)
				.join("");
			const editable = snake.id === "ai" || state.mode !== "play";
			const card = document.createElement("div");
			card.className = `card ${snake.id}`;
			card.innerHTML = `
				<div class="cardhead">
					<span class="${dotClass}"></span>
					<span>${snake.label}</span>
					${editable ? `<select data-persona="${snake.id}">${options}</select>` : `<span class="persona">${PERSONAS[personaKey].label}</span>`}
				</div>
				<div class="taunt">${snake.policyTaunt === "" ? "（还没开口）" : `「${escapeHtml(snake.policyTaunt)}」`}</div>
				${snake.policyReason === "" ? "" : `<div class="reason">${escapeHtml(snake.policyReason)}</div>`}
				<div class="policy">目标 ${snake.policy.target} · 激进 ${snake.policy.aggression.toFixed(1)} · 风险 ${snake.policy.risk.toFixed(1)}</div>
			`;
			dom.brains.appendChild(card);
		}
		for (const select of dom.brains.querySelectorAll("select[data-persona]")) {
			select.addEventListener("change", (event) => {
				state.personas[event.target.dataset.persona] = event.target.value;
			});
		}

		const streaming = [state.notes.you, state.notes.ai].filter((line) => line !== "").join("  ");
		dom.stream.textContent = streaming === "" ? "" : `⏳ ${streaming.slice(-200)}`;

		if (state.game.over) {
			const winner = state.game.winner;
			dom.meta.textContent = winner === null ? "平局" : `${winner === "you" ? blue.label : yellow.label} 获胜`;
		} else {
			dom.meta.textContent = state.meta;
		}
	}

	/**
	 * @param text - raw text.
	 * @returns HTML-escaped text.
	 */
	function escapeHtml(text) {
		return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
	}

	/** 同步模式/速度控件外观。 */
	function renderControls() {
		for (const button of dom.modes.querySelectorAll("button")) {
			button.classList.toggle("on", button.dataset.mode === state.mode);
		}
		dom.speed.value = String(state.speed);
		dom.speedLabel.textContent = SPEEDS[state.speed].label;
		dom.ask.style.display = state.mode === "step" ? "" : "none";
		dom.pause.textContent = state.paused ? "▶ 继续" : "⏸ 暂停";
		dom.hint.textContent = state.paused
			? "已暂停（按 P 或点「继续」恢复）"
			: MODES.find((entry) => entry.id === state.mode).hint;
	}

	/**
	 * 问一次策略卡（异步、不阻塞任何一帧）。
	 *
	 * @param snakeId - `"you"` | `"ai"`.
	 */
	async function refreshBrain(snakeId) {
		const game = state.game;
		const snake = game.snakes.find((entry) => entry.id === snakeId);
		if (snake === undefined || !snake.alive || state.inFlight[snakeId]) return;
		state.inFlight[snakeId] = true;
		state.busy[snakeId] = true;
		renderSide();

		const controller = new AbortController();
		state.controllers[snakeId] = controller;
		let streamed = "";
		const result = await askPolicy({
			game,
			snake,
			personaKey: state.personas[snakeId],
			signal: controller.signal,
			onDelta: (piece) => {
				streamed += piece;
				state.notes[snakeId] = streamed;
				renderSide();
			},
		});

		state.inFlight[snakeId] = false;
		state.busy[snakeId] = false;
		state.controllers[snakeId] = null;

		if (result.ok) {
			snake.policy = result.policy;
			snake.policyReason = result.policy.reason;
			snake.policyTaunt = result.taunt || result.policy.taunt;
			snake.policyAt = game.tick;
			state.notes[snakeId] = "";
			state.meta = `${snake.label} 更新策略 · ${(result.elapsedMs / 1000).toFixed(1)}s`;
		} else if (result.aborted) {
			state.notes[snakeId] = "";
		} else {
			state.notes[snakeId] = `⚠ ${result.error}`;
			state.meta = `${snake.label} 策略失败，继续用旧策略`;
		}
		renderSide();
	}

	/** 两条一起问（单步模式的"让 AI 出招"）。 */
	async function askBoth() {
		state.meta = "问 AI 要新策略…";
		renderSide();
		const jobs = [refreshBrain("ai")];
		if (state.mode !== "play") jobs.push(refreshBrain("you"));
		await Promise.all(jobs);
		moveOne();
	}

	/** 重开一局。 */
	function restart() {
		for (const controller of Object.values(state.controllers)) controller?.abort();
		state.game = createGame();
		state.notes = { you: "", ai: "" };
		state.meta = "新的一局";
		renderSide();
	}

	/**
	 * 暂停 / 继续自动推进。
	 *
	 * 暂停时**掐掉正在飞的策略请求**：留着它们的话，恢复后模型会突然把一份基于
	 * 旧局面的策略拍上来，看起来像"暂停期间它偷偷想好了"。
	 */
	function togglePause() {
		state.paused = !state.paused;
		if (state.paused) {
			for (const controller of Object.values(state.controllers)) controller?.abort();
			state.notes = { you: "", ai: "" };
			state.busy = { you: false, ai: false };
			state.inFlight = { you: false, ai: false };
		} else {
			state.meta = "";
		}
		reschedule();
		renderControls();
		renderSide();
	}

	let tickTimer = null;
	let policyTimer = null;
	/** 跟随模式与速度重启 tick 与策略定时器。 */
	function reschedule() {
		if (tickTimer !== null) window.clearInterval(tickTimer);
		if (policyTimer !== null) window.clearInterval(policyTimer);
		tickTimer = null;
		policyTimer = null;
		if (state.mode === "step" || state.paused) return;

		tickTimer = window.setInterval(() => {
			if (state.game.over) return;
			step(state.game);
			renderSide();
		}, SPEEDS[state.speed].ms);

		const refresh = () => {
			if (state.game.over) return;
			refreshBrain("ai");
			if (state.mode === "live") refreshBrain("you");
		};
		refresh();
		policyTimer = window.setInterval(refresh, POLICY_INTERVAL_MS);
	}

	/** 键盘：P 随时暂停/继续；其余只在"我来玩"模式生效。 */
	function onKey(event) {
		if (event.key === "p" || event.key === "P") {
			event.preventDefault();
			togglePause();
			return;
		}
		if (state.mode !== "play") return;
		const dir = KEY_DIRS[event.key];
		if (dir !== undefined) {
			event.preventDefault();
			state.game.snakes[0].pendingDir = dir;
			return;
		}
		if (event.key === " ") {
			event.preventDefault();
			moveOne();
		}
	}

	dom.modes.addEventListener("click", (event) => {
		const id = event.target?.dataset?.mode;
		if (id === undefined) return;
		state.mode = id;
		renderControls();
		reschedule();
	});
	dom.speed.addEventListener("input", () => {
		state.speed = Number(dom.speed.value);
		renderControls();
		reschedule();
	});
	dom.ask.addEventListener("click", () => void askBoth());
	dom.one.addEventListener("click", () => moveOne());
	dom.pause.addEventListener("click", () => togglePause());
	dom.restart.addEventListener("click", () => restart());
	window.addEventListener("keydown", onKey);

	let raf = 0;
	const loop = (time) => {
		paintBoard(dom.board, state.game, time);
		raf = window.requestAnimationFrame(loop);
	};

	for (const entry of MODES) {
		const button = document.createElement("button");
		button.dataset.mode = entry.id;
		button.textContent = entry.label;
		dom.modes.appendChild(button);
	}
	renderControls();
	renderSide();
	reschedule();
	raf = window.requestAnimationFrame(loop);

	// 注意：不能在这里 clearInterval —— 见下面的返回值。
	return () => {
		window.cancelAnimationFrame(raf);
		if (tickTimer !== null) window.clearInterval(tickTimer);
		if (policyTimer !== null) window.clearInterval(policyTimer);
		for (const controller of Object.values(state.controllers)) controller?.abort();
		window.removeEventListener("keydown", onKey);
		container.innerHTML = "";
	};
}
