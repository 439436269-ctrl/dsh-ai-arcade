/**
 * 中国象棋的界面。
 *
 * 与贪吃蛇共用一个外壳（`app.js` 的 tab），但棋盘、交互、AI 调度都是自己的。
 *
 * 棋力分工在这里体现得很清楚：**走子完全由本地引擎决定**（`pickMove`，按难度
 * 滑杆给深度与失误率），模型只做一件它擅长的事——**解说**。所以断网、模型超时、
 * 额度用尽，棋都照下不误，只是少了那张嘴。
 *
 * @module src/web/xiangqi-view
 */

import { askBrain } from "../client/llm.js";
import { paintXiangqi, hitTest } from "../client/render-xiangqi.js";
import { pickMove } from "../client/games/xiangqi/ai.js";
import {
	BLACK,
	RED,
	NAMES,
	describeMove,
	findKing,
	gameStatus,
	initialBoard,
	isInCheck,
	legalMoves,
	makeMove,
} from "../client/games/xiangqi/rules.js";

const TEMPLATE = `
<div class="xq">
  <div class="xq-left">
    <canvas id="xq-board"></canvas>
    <div class="row">
      <button class="act" id="xq-restart">重新开始</button>
      <button class="ghost" id="xq-pause">⏸ 暂停</button>
      <button class="ghost" id="xq-undo">悔棋</button>
      <span class="meta" id="xq-status"></span>
    </div>
  </div>
  <aside class="side">
    <div class="xq-controls">
      <label class="speed">难度 <input type="range" id="xq-level" min="1" max="10" step="1" value="5"><span id="xq-level-label">5</span></label>
      <div class="seg" id="xq-modes">
        <button data-mode="human">人机对弈</button>
        <button data-mode="auto">AI 对弈</button>
      </div>
    </div>
    <div class="xq-comment" id="xq-comment">点自己的棋子，再点目标格落子。红方是你。</div>
    <div class="xq-log" id="xq-log"></div>
  </aside>
</div>
`;

/** 难度滑杆 → 引擎参数（低级也会"失误"，不只是算得浅）。 */
const LEVEL_HINT = [
	"1 级 · 几乎只看一步，常走漏着",
	"2 级 · 会吃白送的子，但看不见陷阱",
	"3 级 · 入门：能保住子力",
	"4 级 · 业余初段：会算两步",
	"5 级 · 业余：攻守有度",
	"6 级 · 业余强：很少送子",
	"7 级 · 准高手：开始做杀",
	"8 级 · 高手：算得深",
	"9 级 · 强手：几乎不失手",
	"10 级 · 满级：全力搜索",
];

/**
 * 挂载象棋界面。
 *
 * @param container - 承载界面的元素（外壳已清空）。
 * @returns 卸载函数。
 */
export function mount(container) {
	container.innerHTML = TEMPLATE;

	const dom = {
		board: container.querySelector("#xq-board"),
		restart: container.querySelector("#xq-restart"),
		pause: container.querySelector("#xq-pause"),
		undo: container.querySelector("#xq-undo"),
		status: container.querySelector("#xq-status"),
		level: container.querySelector("#xq-level"),
		levelLabel: container.querySelector("#xq-level-label"),
		modes: container.querySelector("#xq-modes"),
		comment: container.querySelector("#xq-comment"),
		log: container.querySelector("#xq-log"),
	};

	const state = {
		board: initialBoard(),
		paused: false,
		side: RED,
		mode: "human",
		level: 5,
		selected: null,
		targets: [],
		lastMove: null,
		history: [],
		status: "playing",
		thinking: false,
		over: false,
		comment: "点自己的棋子，再点目标格落子。红方是你，黑方是 AI。",
		controller: null,
	};

	let raf = 0;
	let timer = null;

	/** 重画棋盘。 */
	function draw(time) {
		paintXiangqi(
			dom.board,
			{
				board: state.board,
				selected: state.selected,
				targets: state.targets,
				lastMove: state.lastMove,
				checkedSide: !state.over && isInCheck(state.board, state.side) ? state.side : null,
			},
			time
		);
	}

	/** 重画侧栏与状态。 */
	function renderSide() {
		dom.level.value = String(state.level);
		dom.levelLabel.textContent = String(state.level);
		for (const button of dom.modes.querySelectorAll("button")) {
			button.classList.toggle("on", button.dataset.mode === state.mode);
		}

		const statusText = state.over
			? state.status === "checkmate"
				? `${state.side === RED ? "红方" : "黑方"}被将死 —— ${state.side === RED ? "黑方" : "红方"}胜`
				: "困毙（无子可动）—— 同判负"
			: state.paused
				? "已暂停（按 P 或点「继续」恢复）"
				: state.thinking
					? "AI 思考中…"
					: `${state.side === RED ? "红方" : "黑方"}走棋${isInCheck(state.board, state.side) ? " · 被将军！" : ""}`;
		dom.status.textContent = `${statusText} · ${LEVEL_HINT[state.level - 1]}`;
		dom.pause.textContent = state.paused ? "▶ 继续" : "⏸ 暂停";

		dom.comment.textContent = state.comment === "" ? "…" : state.comment;

		dom.log.innerHTML = "";
		state.history.forEach((entry, index) => {
			const row = document.createElement("div");
			row.className = "xq-move";
			row.innerHTML = `<span class="xq-no">${Math.floor(index / 2) + 1}${index % 2 === 0 ? "." : "…"}</span>` +
				`<span class="${entry.side === RED ? "red" : "black"}">${entry.text}</span>`;
			dom.log.appendChild(row);
		});
		dom.log.scrollTop = dom.log.scrollHeight;
	}

	/** 状态 + 侧栏一起刷新。 */
	function render() {
		renderSide();
	}

	/** 判断终局。 */
	function checkOver() {
		const status = gameStatus(state.board, state.side);
		if (status === "checkmate" || status === "stalemate") {
			state.status = status;
			state.over = true;
			return true;
		}
		return false;
	}

	/**
	 * 落子并推进回合。
	 *
	 * @param move - `{ from, to }`。
	 */
	function commit(move) {
		const notation = describeMove(state.board, move);
		const mover = state.side;
		makeMove(state.board, move);
		state.history.push({ move, text: notation, side: mover });
		state.lastMove = move;
		state.selected = null;
		state.targets = [];
		state.side = mover === RED ? BLACK : RED;
		checkOver();
		render();
	}

	/** 轮到 AI 就让它走；人的回合则什么都不做。 */
	function scheduleAi() {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		if (state.over || state.paused) return;
		const aiTurn = state.mode === "auto" || state.side === BLACK;
		if (!aiTurn) return;

		state.thinking = true;
		render();
		// 自战时把节奏压慢：level 5 的三层搜索只要几十毫秒，若不加停顿，一局棋几秒
		// 就下完了，根本看不清谁走了什么、吃了什么。人机模式也留一点"思考感"。
		const thinkDelay = state.mode === "auto" ? 750 : 420;
		// 先让界面把"思考中"画出来，再去跑同步搜索（搜索会占住主线程）。
		timer = window.setTimeout(() => {
			timer = null;
			// 这 220ms 里可能被暂停了——搜索一旦开始就没法中断（它是同步的），
			// 所以在开跑之前拦一道。
			if (state.over || state.paused) {
				state.thinking = false;
				render();
				return;
			}
			const before = state.board.map((row) => row.slice());
			const picked = pickMove(state.board, state.side, state.level, { timeMs: state.level >= 9 ? 2200 : 1200 });
			state.thinking = false;
			if (picked === null) {
				checkOver();
				render();
				return;
			}
			commit(picked.move);
			if (state.over) return;
			void commentate(before, picked);
			// AI 对弈模式：接着让另一方走。
			if (state.mode === "auto") scheduleAi();
		}, thinkDelay);
	}

	/**
	 * 暂停 / 继续。
	 *
	 * 暂停会停掉 AI 调度并禁掉落子（整盘棋冻结），但**解说不掐**——那是一句话，
	 * 让它说完比半路截断更自然。
	 */
	function togglePause() {
		state.paused = !state.paused;
		if (state.paused) {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
			state.thinking = false;
		}
		render();
		if (!state.paused) scheduleAi();
	}

	/**
	 * 让模型就刚才那步棋说一句话。
	 *
	 * 刻意**不 await**：解说慢或失败都不该拦住下一手棋。
	 *
	 * @param beforeBoard - 走子前的局面。
	 * @param picked - 引擎的选择（含候选列表）。
	 */
	async function commentate(beforeBoard, picked) {
		const side = picked.move.piece[0];
		const candidates = picked.candidates
			.slice(0, 3)
			.map((entry, index) => `${index + 1}. ${describeMove(beforeBoard, entry.move)}（评分 ${Math.round(entry.score)}）`)
			.join("\n");
		const prompt = [
			`你在解说一盘中国象棋。刚刚${side === RED ? "红方" : "黑方"}走了 ${describeMove(beforeBoard, picked.move)}。`,
			"本地引擎给出的候选是：",
			candidates,
			`它选了第 ${picked.candidates.findIndex((entry) => entry.move === picked.move) + 1} 个。`,
			"请用不超过 24 个字，以这位棋手的第一人称说一句这步棋的意图或心理（可以有点个性），只输出这一句话。",
		].join("\n");

		// 上一句还没说完就跳过这次：掐断半截请求既浪费已经花掉的 token，也不会让
		// 界面更清楚——少说一句胜过说半句。AI 自战时几十步连走，这里是主要闸门。
		if (state.controller !== null) return;
		const controller = new AbortController();
		state.controller = controller;
		state.comment = "…";
		render();
		const result = await askBrain({ prompt, signal: controller.signal });
		state.controller = null;
		if (!result.ok) {
			state.comment = result.aborted ? "…" : `（解说不可用：${result.error}）`;
		} else {
			state.comment = `「${result.text.trim().slice(0, 60)}」`;
		}
		render();
	}

	// ── 交互 ────────────────────────────────────────────────────────
	/**
	 * 处理一次点击：选子、取消、或落子。
	 *
	 * @param event - pointer event.
	 */
	function onClick(event) {
		// 暂停时整盘棋冻结，包括人的落子——否则"暂停"就只是"AI 暂停"。
		if (state.over || state.thinking || state.paused) return;
		// AI 对弈模式不让人类插手；人机模式下人类只走红方。
		if (state.mode === "auto") return;
		if (state.side !== RED) return;

		const cell = hitTest(dom.board, event.clientX, event.clientY);
		if (cell === null) return;
		const [x, y] = cell;
		const piece = state.board[y][x];

		// 点自己的子：选中并算出合法目标。
		if (piece !== null && piece[0] === state.side) {
			state.selected = [x, y];
			state.targets = legalMoves(state.board, state.side)
				.filter((move) => move.from[0] === x && move.from[1] === y)
				.map((move) => move.to);
			render();
			return;
		}

		// 点目标格：走过去。
		if (state.selected !== null) {
			const chosen = state.targets.find(([tx, ty]) => tx === x && ty === y);
			if (chosen !== undefined) {
				commit({ from: state.selected, to: [x, y] });
				if (!state.over) scheduleAi();
				return;
			}
		}
		// 点空处：取消选中。
		state.selected = null;
		state.targets = [];
		render();
	}

	dom.board.addEventListener("click", onClick);

	dom.pause.addEventListener("click", () => togglePause());

	/** P 键随时暂停/继续。 */
	function onKey(event) {
		if (event.key !== "p" && event.key !== "P") return;
		event.preventDefault();
		togglePause();
	}
	window.addEventListener("keydown", onKey);

	dom.restart.addEventListener("click", () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		state.controller?.abort();
		state.board = initialBoard();
		state.side = RED;
		state.selected = null;
		state.targets = [];
		state.lastMove = null;
		state.history = [];
		state.status = "playing";
		state.over = false;
		state.thinking = false;
		state.comment = "新的一局。红方先行。";
		render();
		scheduleAi();
	});

	dom.undo.addEventListener("click", () => {
		// 人机模式下退两步（自己 + AI），观战模式退一步。
		if (state.history.length === 0 || state.thinking) return;
		const back = state.mode === "auto" ? 1 : 2;
		for (let i = 0; i < back && state.history.length > 0; i += 1) {
			const entry = state.history.pop();
			const snapshot = state.board.map((row) => row.slice());
			void snapshot;
			// 用「重放」比记录被吃子更简单，也更容易验证。
			const moves = state.history.map((item) => item.move);
			state.board = initialBoard();
			for (const move of moves) makeMove(state.board, move);
			state.side = entry.side;
		}
		state.lastMove = state.history.length > 0 ? state.history[state.history.length - 1].move : null;
		state.over = false;
		state.status = "playing";
		state.selected = null;
		state.targets = [];
		checkOver();
		render();
	});

	dom.level.addEventListener("input", () => {
		state.level = Number(dom.level.value);
		render();
	});

	dom.modes.addEventListener("click", (event) => {
		const mode = event.target?.dataset?.mode;
		if (mode === undefined) return;
		state.mode = mode;
		state.comment = mode === "auto" ? "AI 对弈：红黑双方都由引擎驱动。" : "人机对弈：你执红，AI 执黑。";
		render();
		if (mode === "auto") scheduleAi();
	});

	// 绘制循环（被将军时帅将呼吸，需要持续重绘）。
	const loop = (time) => {
		draw(time);
		raf = window.requestAnimationFrame(loop);
	};
	raf = window.requestAnimationFrame(loop);
	render();

	return () => {
		window.cancelAnimationFrame(raf);
		if (timer !== null) window.clearTimeout(timer);
		state.controller?.abort();
		dom.board.removeEventListener("click", onClick);
		window.removeEventListener("keydown", onKey);
		container.innerHTML = "";
		// 引用一下，避免打包器把未使用的导入摇掉（NAMES/findKing 供调试用）。
		void NAMES;
		void findKing;
	};
}
