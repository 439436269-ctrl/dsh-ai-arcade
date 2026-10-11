/**
 * 棋盘绘制（纯函数：只读游戏状态，不碰 React，不产生副作用）。
 *
 * 分成独立模块的原因很实际：绘制每帧都在跑，而游戏状态每 tick 才变一次，
 * 两者节奏不同。把绘制做成"给一块 canvas 和一份状态就画"的纯函数，游戏逻辑
 * 就不必关心里面有多少是 Canvas API。
 *
 * @module src/client/render
 */

/** 两条蛇与食物的配色。 */
export const COLORS = Object.freeze({
	you: { head: "#7ee787", body: "#2f7d3a", glow: "rgba(126,231,135,.35)" },
	ai: { head: "#f2c14e", body: "#8c6d1f", glow: "rgba(242,193,78,.35)" },
	food: "#ff7b72",
	board: "#0d1117",
	grid: "rgba(255,255,255,.045)",
});

/**
 * 画一帧。
 *
 * 棋盘永远是正方形并居中：flex 布局给出的元素可能是任意长宽比，直接用元素
 * 尺寸画会把网格拉成矩形、蛇看起来是扁的。
 *
 * @param canvas - the canvas element.
 * @param game - current game state (may be null before the first tick).
 * @param time - monotonic timestamp from requestAnimationFrame.
 */
export function paintBoard(canvas, game, time) {
	const box = canvas.getBoundingClientRect();
	const cssWidth = Math.max(120, box.width);
	const cssHeight = Math.max(120, box.height);
	const dpr = window.devicePixelRatio || 1;
	const pixelWidth = Math.round(cssWidth * dpr);
	const pixelHeight = Math.round(cssHeight * dpr);
	if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
		canvas.width = pixelWidth;
		canvas.height = pixelHeight;
	}
	const g = canvas.getContext("2d");
	if (g === null) return;
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, cssWidth, cssHeight);
	g.fillStyle = COLORS.board;
	g.fillRect(0, 0, cssWidth, cssHeight);
	if (game === null) return;

	const side = Math.min(cssWidth, cssHeight);
	const cell = side / game.grid;
	g.save();
	g.translate((cssWidth - side) / 2, (cssHeight - side) / 2);

	g.strokeStyle = COLORS.grid;
	g.lineWidth = 1;
	for (let i = 1; i < game.grid; i += 1) {
		const at = Math.round(i * cell) + 0.5;
		g.beginPath();
		g.moveTo(at, 0);
		g.lineTo(at, side);
		g.moveTo(0, at);
		g.lineTo(side, at);
		g.stroke();
	}

	if (game.food !== null) {
		const pulse = 0.72 + 0.28 * Math.sin(time / 320);
		g.fillStyle = COLORS.food;
		g.globalAlpha = pulse;
		g.beginPath();
		g.arc((game.food[0] + 0.5) * cell, (game.food[1] + 0.5) * cell, cell * 0.3, 0, Math.PI * 2);
		g.fill();
		g.globalAlpha = 1;
	}

	for (const snake of game.snakes) {
		const palette = COLORS[snake.id] ?? COLORS.you;
		snake.body.forEach(([x, y], index) => {
			const isHead = index === 0;
			const pad = cell * (isHead ? 0.05 : 0.12);
			g.fillStyle = isHead ? palette.head : palette.body;
			if (!snake.alive) g.globalAlpha = 0.35;
			g.beginPath();
			g.roundRect(x * cell + pad, y * cell + pad, cell - pad * 2, cell - pad * 2, cell * 0.28);
			g.fill();
			g.globalAlpha = 1;
		});
		// Eyes: the only cue that tells you which way a snake is facing.
		const head = snake.body[0];
		const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[snake.dir] ?? [1, 0];
		const cx = (head[0] + 0.5) * cell;
		const cy = (head[1] + 0.5) * cell;
		g.fillStyle = "#0d1117";
		for (const side_ of [-1, 1]) {
			g.beginPath();
			g.arc(cx + dx * cell * 0.16 - dy * side_ * cell * 0.15, cy + dy * cell * 0.16 - dx * side_ * cell * 0.15, cell * 0.075, 0, Math.PI * 2);
			g.fill();
		}
	}
	g.restore();
}
