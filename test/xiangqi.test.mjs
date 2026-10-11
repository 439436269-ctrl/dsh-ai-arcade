/**
 * 象棋规则引擎与搜索的测试。
 *
 * 棋类代码必须验证才有意义——一个漏掉的马腿或象眼会让整盘棋悄悄变味，而且
 * 极难从结果倒推。所以这里分成两组：
 *   - **规则**：马腿、象眼、炮架、过河兵、九宫、将帅照面、将死/困毙；
 *   - **搜索**：能不能吃到明摆着的子、能不能认出一手将死。
 *
 * `node --test test/xiangqi.test.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BLACK,
	HEIGHT,
	RED,
	WIDTH,
	cloneBoard,
	gameStatus,
	generateMoves,
	initialBoard,
	isInCheck,
	legalMoves,
	makeMove,
	movesForPiece,
	undoMove,
} from "../src/client/games/xiangqi/rules.js";
import { evaluate, findBestMoves, pickMove } from "../src/client/games/xiangqi/ai.js";

/**
 * @returns an empty board.
 */
function emptyBoard() {
	return Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(null));
}

test("开局：各棋子走法数与总数", () => {
	const board = initialBoard();
	const moves = legalMoves(board, RED);
	const byPiece = {};
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			const piece = board[y][x];
			if (piece === null || piece[0] !== RED) continue;
			const count = movesForPiece(board, x, y).length;
			const key = `${piece}(${x},${y})`;
			byPiece[key] = count;
		}
	}

	// 逐项列出，便于人工复核（车被马挡、炮要炮架、马被自己相蹩腿）。
	assert.equal(byPiece["rR(0,9)"], 2, "左侧车只能沿边线上两步，横向被马挡住");
	assert.equal(byPiece["rR(8,9)"], 2);
	assert.equal(byPiece["rN(1,9)"], 2, "马被自己的相蹩住一侧");
	assert.equal(byPiece["rN(7,9)"], 2);
	assert.equal(byPiece["rC(1,7)"], 12, "炮：向上 4 步（1,3 是空的，卒在偶数格）+ 翻过黑炮吃马 1 步 + 向下 1 + 向左 1 + 向右 5");
	assert.equal(byPiece["rC(7,7)"], 12);
	assert.equal(byPiece["rB(2,9)"], 2);
	assert.equal(byPiece["rB(6,9)"], 2);
	assert.equal(byPiece["rA(3,9)"], 1);
	assert.equal(byPiece["rA(5,9)"], 1);
	assert.equal(byPiece["rK(4,9)"], 1);
	for (const x of [0, 2, 4, 6, 8]) assert.equal(byPiece[`rP(${x},6)`], 1, "兵未过河只能直进");

	const total = Object.values(byPiece).reduce((sum, value) => sum + value, 0);
	assert.equal(moves.length, total, "legalMoves 应与逐子统计一致");
	// 44 是中国象棋开局合法着法的标准值：车 4 + 马 4 + 相 4 + 仕 2 + 帅 1 + 兵 5 + 炮 24。
	assert.equal(total, 44, "开局红方合法着法总数");
});

test("马腿被蹩时走法消失", () => {
	const board = emptyBoard();
	// 帅必须避开马的落点与马腿，否则会悄悄把马"堵"住（(5,4) 正是马腿之一）。
	board[9][4] = "rK";
	board[0][0] = "bK";
	board[4][4] = "rN";
	const free = movesForPiece(board, 4, 4).length;
	assert.equal(free, 8, "空旷中央的马有八个落点");

	// board[y][x]：(x=4, y=3) 才是向上跳的马腿，不是 board[4][3]。
	board[3][4] = "rP"; // 挡住向上的马腿
	const blocked = movesForPiece(board, 4, 4).length;
	assert.equal(blocked, 6, "蹩住一条腿后少两个落点");
	for (const [x, y] of movesForPiece(board, 4, 4)) {
		assert.ok(!(x === 3 && y === 2) && !(x === 5 && y === 2), "被蹩腿方向的落点必须消失");
	}
});

test("象眼被堵时不能飞", () => {
	const board = emptyBoard();
	board[9][4] = "rK";
	board[0][4] = "bK";
	board[9][2] = "rB";
	assert.ok(movesForPiece(board, 2, 9).some(([x, y]) => x === 4 && y === 7), "象眼通畅时可以走田");

	board[8][3] = "rP"; // 堵住通向 (4,7) 的象眼
	assert.ok(!movesForPiece(board, 2, 9).some(([x, y]) => x === 4 && y === 7), "象眼被堵则该方向不可走");
});

test("象不能过河", () => {
	const board = emptyBoard();
	board[9][4] = "rK";
	board[0][4] = "bK";
	board[5][2] = "rB"; // 恰好停在河界红方一侧
	for (const [x, y] of movesForPiece(board, 2, 5)) {
		assert.ok(y >= 5, "红相不得越过河界");
	}
});

test("炮必须翻过炮架才能吃子", () => {
	const board = emptyBoard();
	board[9][4] = "rK";
	board[0][4] = "bK";
	board[7][1] = "rC";
	board[3][1] = "bN";

	assert.ok(!movesForPiece(board, 1, 7).some(([x, y]) => x === 1 && y === 3), "中间无架子时不能吃");

	board[5][1] = "rP"; // 支起炮架
	assert.ok(movesForPiece(board, 1, 7).some(([x, y]) => x === 1 && y === 3), "有架子后可以吃");
	assert.ok(!movesForPiece(board, 1, 7).some(([x, y]) => x === 1 && y === 5), "炮架那一格本身不能落子");
});

test("兵过河后才能横走", () => {
	const board = emptyBoard();
	board[9][4] = "rK";
	board[0][4] = "bK";
	board[6][4] = "rP";
	assert.deepEqual(
		movesForPiece(board, 4, 6).map(([x, y]) => `${x},${y}`),
		["4,5"],
		"未过河只能直进"
	);
	board[6][4] = null;
	board[4][4] = "rP";
	assert.equal(movesForPiece(board, 4, 4).length, 3, "过河后可直进与左右横走");
});

test("将帅照面视为将军", () => {
	const board = emptyBoard();
	board[9][4] = "rK";
	board[0][4] = "bK";
	assert.ok(isInCheck(board, RED), "同列无遮挡时，红方处于被将状态");
	assert.ok(isInCheck(board, BLACK), "对黑方同样成立");

	board[5][4] = "rP"; // 中间放一个子挡住
	assert.ok(!isInCheck(board, RED));
	assert.ok(!isInCheck(board, BLACK));
});

test("被将军时只能走应将的着法", () => {
	const board = emptyBoard();
	board[9][4] = "rK";
	board[0][0] = "bK";
	board[0][4] = "bR"; // 沿 4 列将军
	assert.ok(isInCheck(board, RED));

	const moves = legalMoves(board, RED);
	assert.ok(moves.length > 0, "还有解");
	for (const move of moves) {
		const captured = makeMove(board, move);
		const still = isInCheck(board, RED);
		undoMove(board, move, captured);
		assert.ok(!still, `走法 ${JSON.stringify(move)} 走完后仍被将军，不该出现在合法着法里`);
	}
});

test("makeMove / undoMove 往返一致", () => {
	const board = initialBoard();
	const snapshot = JSON.stringify(board);
	for (const move of generateMoves(board, RED).slice(0, 12)) {
		const captured = makeMove(board, move);
		undoMove(board, move, captured);
		assert.equal(JSON.stringify(board), snapshot, "撤销后局面必须完全复原");
	}
});

test("识别将死", () => {
	// 双车错：黑将在底线被横线车控制，纵向逃路被另一车封死。
	// 红帅放在 (3,9) 而不是 (4,9)——否则将帅同列会成为"飞将"，那本身就是将军，
	// 测出来的将死是照面造成的，不是双车错造成的。
	const board = emptyBoard();
	board[9][3] = "rK";
	board[0][4] = "bK";
	board[0][0] = "rR";
	board[1][0] = "rR";
	assert.equal(gameStatus(board, BLACK), "checkmate");
});

test("搜索能吃到白送的车", () => {
	const board = emptyBoard();
	board[9][3] = "rK"; // 避开与黑将同列
	board[0][4] = "bK";
	board[5][0] = "rR";
	board[3][0] = "bR"; // 无保护，正上方两步
	const best = findBestMoves(board, RED, { depth: 2, limit: 3 });
	assert.ok(best.length > 0);
	assert.deepEqual(best[0].move.to, [0, 3], "最佳着法应吃掉无保护的车");
	assert.ok(evaluate(board, RED) > -Infinity);
});

test("搜索能认出一手将死", () => {
	// 红车 (0,0) 已控制底线，把另一个车送到 y=1 行即成双车错。
	const board = emptyBoard();
	board[9][3] = "rK";
	board[0][4] = "bK";
	board[0][0] = "rR";
	board[2][1] = "rR";
	const best = findBestMoves(board, RED, { depth: 3, limit: 3 });
	assert.ok(best.length > 0);
	assert.ok(best[0].score > 100_000, `应看到绝杀分，实际 ${best[0].score}`);
});

test("难度滑杆：低级会失误、高级不会（同一局面统计）", () => {
	const board = emptyBoard();
	board[9][3] = "rK";
	board[0][4] = "bK";
	board[5][0] = "rR";
	board[3][0] = "bR";
	board[4][6] = "bN";

	let lowBest = 0;
	let highBest = 0;
	let seed = 1;
	const rand = () => {
		// 固定序列，保证测试可复现。
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	for (let i = 0; i < 20; i += 1) {
		const low = pickMove(cloneBoard(board), RED, 1, { rand });
		const high = pickMove(cloneBoard(board), RED, 10, { rand });
		if (low !== null && low.move.to[0] === 0 && low.move.to[1] === 3) lowBest += 1;
		if (high !== null && high.move.to[0] === 0 && high.move.to[1] === 3) highBest += 1;
	}
	assert.equal(highBest, 20, "最高难度每次都应选中吃车");
	assert.ok(lowBest < 20, `最低难度应有失误（实际命中 ${lowBest}/20）`);
});

test("引擎自我对弈若干步不会崩", () => {
	const board = initialBoard();
	let side = RED;
	let seed = 7;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	for (let ply = 0; ply < 8; ply += 1) {
		const picked = pickMove(board, side, 4, { rand, timeMs: 400 });
		if (picked === null) break;
		makeMove(board, picked.move);
		side = side === RED ? BLACK : RED;
	}
	const status = gameStatus(board, side);
	assert.ok(["playing", "check", "checkmate", "stalemate"].includes(status), `意外状态 ${status}`);
});
