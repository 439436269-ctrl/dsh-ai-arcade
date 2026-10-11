/**
 * 象棋棋盘绘制（纯函数：只读局面，不产生副作用）。
 *
 * 用法与贪吃蛇的 `render.js` 一致——给一块 canvas 和一份视图状态就画。坐标换算
 * 同时被绘制和点击命中共用（`geometry` / `hitTest`），避免"看到的格子"和"点到的
 * 格子"因为两套算法而错位。
 *
 * @module src/client/render-xiangqi
 */

import { HEIGHT, NAMES, WIDTH } from "./games/xiangqi/rules.js";

const COLORS = Object.freeze({
	board: "#1a1f27",
	line: "rgba(230,232,238,.30)",
	river: "rgba(230,232,238,.16)",
	red: "#ff6b6b",
	black: "#c9d1d9",
	selected: "rgba(91,141,239,.85)",
	target: "rgba(126,231,135,.75)",
	lastMove: "rgba(242,193,78,.55)",
	check: "rgba(229,83,75,.75)",
});

/**
 * 由画布尺寸推出格子大小与原点。
 *
 * @param cssWidth - canvas CSS 宽。
 * @param cssHeight - canvas CSS 高。
 * @returns `{ cell, originX, originY }`。
 */
export function geometry(cssWidth, cssHeight) {
	// 8 格宽 + 9 格高，外加给棋子半径留的边距。
	const cell = Math.min((cssWidth - 20) / 8.9, (cssHeight - 20) / 9.9);
	const originX = (cssWidth - cell * (WIDTH - 1)) / 2;
	const originY = (cssHeight - cell * (HEIGHT - 1)) / 2;
	return { cell, originX, originY };
}

/**
 * 把画布坐标换算成棋盘格坐标。
 *
 * @param canvas - the canvas element.
 * @param clientX - pointer clientX.
 * @param clientY - pointer clientY.
 * @returns `[x, y]`，超出容差时返回 null。
 */
export function hitTest(canvas, clientX, clientY) {
	const rect = canvas.getBoundingClientRect();
	const { cell, originX, originY } = geometry(rect.width, rect.height);
	const x = Math.round((clientX - rect.left - originX) / cell);
	const y = Math.round((clientY - rect.top - originY) / cell);
	if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return null;
	const dx = Math.abs(clientX - rect.left - (originX + x * cell));
	const dy = Math.abs(clientY - rect.top - (originY + y * cell));
	if (dx > cell * 0.55 || dy > cell * 0.55) return null;
	return [x, y];
}

/**
 * 画一帧。
 *
 * @param canvas - the canvas element.
 * @param view - `{ board, selected, targets, lastMove, checkedSide, side }`.
 * @param time - rAF timestamp（用来做被将军时的呼吸高亮）。
 */
export function paintXiangqi(canvas, view, time) {
	const box = canvas.getBoundingClientRect();
	const cssWidth = Math.max(160, box.width);
	const cssHeight = Math.max(160, box.height);
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
	g.fillStyle = COLORS.board;
	g.fillRect(0, 0, cssWidth, cssHeight);

	const { cell, originX, originY } = geometry(cssWidth, cssHeight);
	const px = (x) => originX + x * cell;
	const py = (y) => originY + y * cell;

	// 网格：河界那一行（y=4..5 之间）不画竖线。
	g.strokeStyle = COLORS.line;
	g.lineWidth = 1;
	for (let y = 0; y < HEIGHT; y += 1) {
		const at = Math.round(py(y)) + 0.5;
		g.beginPath();
		g.moveTo(px(0), at);
		g.lineTo(px(WIDTH - 1), at);
		g.stroke();
	}
	for (let x = 0; x < WIDTH; x += 1) {
		const at = Math.round(px(x)) + 0.5;
		g.beginPath();
		g.moveTo(at, py(0));
		g.lineTo(at, py(4));
		g.moveTo(at, py(5));
		g.lineTo(at, py(9));
		g.stroke();
	}
	// 九宫斜线。
	for (const [x0, x1, y0, y1] of [
		[3, 5, 0, 2],
		[3, 5, 7, 9],
	]) {
		g.beginPath();
		g.moveTo(px(x0), py(y0));
		g.lineTo(px(x1), py(y1));
		g.moveTo(px(x1), py(y0));
		g.lineTo(px(x0), py(y1));
		g.stroke();
	}

	g.fillStyle = COLORS.river;
	g.font = `${Math.round(cell * 0.44)}px -apple-system,"PingFang SC",sans-serif`;
	g.textAlign = "center";
	g.textBaseline = "middle";
	g.fillText("楚 河", px(2), (py(4) + py(5)) / 2);
	g.fillText("汉 界", px(6), (py(4) + py(5)) / 2);

	// 最后一步：起终点各画一个淡框。
	if (view.lastMove !== undefined && view.lastMove !== null) {
		g.strokeStyle = COLORS.lastMove;
		g.lineWidth = 2;
		for (const [x, y] of [view.lastMove.from, view.lastMove.to]) {
			g.strokeRect(px(x) - cell * 0.44, py(y) - cell * 0.44, cell * 0.88, cell * 0.88);
		}
	}

	// 选中的子：一个圈。
	if (view.selected !== null && view.selected !== undefined) {
		g.strokeStyle = COLORS.selected;
		g.lineWidth = 2.5;
		g.beginPath();
		g.arc(px(view.selected[0]), py(view.selected[1]), cell * 0.46, 0, Math.PI * 2);
		g.stroke();
	}

	// 可走位置：小圆点；能吃子的地方画成圈。
	for (const [x, y] of view.targets ?? []) {
		g.strokeStyle = COLORS.target;
		g.lineWidth = 2;
		const occupied = view.board[y][x] !== null;
		g.beginPath();
		g.arc(px(x), py(y), cell * (occupied ? 0.44 : 0.13), 0, Math.PI * 2);
		if (occupied) g.stroke();
		else {
			g.fillStyle = COLORS.target;
			g.fill();
		}
	}

	// 棋子。
	const checkedSide = view.checkedSide ?? null;
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			const piece = view.board[y][x];
			if (piece === null) continue;
			const isRed = piece[0] === "r";
			const color = isRed ? COLORS.red : COLORS.black;
			const radius = cell * 0.42;
			// 被将军的那一方，帅/将不停呼吸。
			if (checkedSide === piece[0] && piece[1] === "K") {
				const pulse = 0.45 + 0.35 * Math.sin(time / 220);
				g.fillStyle = COLORS.check;
				g.globalAlpha = pulse;
				g.beginPath();
				g.arc(px(x), py(y), radius * 1.22, 0, Math.PI * 2);
				g.fill();
				g.globalAlpha = 1;
			}
			g.fillStyle = "#11151b";
			g.beginPath();
			g.arc(px(x), py(y), radius, 0, Math.PI * 2);
			g.fill();
			g.strokeStyle = color;
			g.lineWidth = 2;
			g.stroke();
			g.fillStyle = color;
			g.font = `600 ${Math.round(cell * 0.52)}px -apple-system,"PingFang SC",sans-serif`;
			g.fillText(NAMES[piece] ?? piece[1], px(x), py(y) + cell * 0.02);
		}
	}
}
