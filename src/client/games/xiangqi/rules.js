/**
 * 中国象棋规则引擎。
 *
 * 坐标系：`board[y][x]`，x 是 0..8（左→右），y 是 0..9（上→下）。**黑方在上**
 * （y 小），红方在下（y 大），所以红方"前进"是 y−1，黑方"前进"是 y+1。棋子编码
 * 是两字符字符串：阵营 + 类型，例如 `"rK"`（红帅）、`"bP"`（黑卒）。
 *
 * 这一层只管规则，不管 AI，也不碰 DOM。它必须在两个方向上都精确：
 *   - 生成走法时严守**马腿、象眼、炮架、不过河、九宫、将帅照面**；
 *   - 判定胜负时区分**将死**与**困毙**（象棋里两者都算输）。
 *
 * 走法分两级：`generateMoves` 出**伪合法**走法（快，不检查走后自将），
 * `legalMoves` 才是真正能走的。搜索引擎用前者加"吃将即胜"的剪枝（标准做法，
 * 快得多），根节点和 UI 用后者。
 *
 * @module src/client/games/xiangqi/rules
 */

export const RED = "r";
export const BLACK = "b";

export const WIDTH = 9;
export const HEIGHT = 10;

/** 棋子类型：帅/仕/相/马/车/炮/兵。 */
export const TYPES = Object.freeze({ KING: "K", ADVISOR: "A", BISHOP: "B", KNIGHT: "N", ROOK: "R", CANNON: "C", PAWN: "P" });

/** 子力价值，用于评估与走法排序（帅的价值只是占位，实战中不会真被吃）。 */
export const VALUES = Object.freeze({ K: 6000, R: 900, C: 450, N: 400, B: 200, A: 200, P: 100 });

/** 中文名，给界面用。 */
export const NAMES = Object.freeze({
	rK: "帅", rA: "仕", rB: "相", rN: "马", rR: "车", rC: "炮", rP: "兵",
	bK: "将", bA: "士", bB: "象", bN: "马", bR: "车", bC: "炮", bP: "卒",
});

/**
 * 开局摆子。
 *
 * @returns a fresh `10×9` board.
 */
export function initialBoard() {
	const empty = () => new Array(WIDTH).fill(null);
	const board = Array.from({ length: HEIGHT }, empty);
	const back = (side) => [`${side}R`, `${side}N`, `${side}B`, `${side}A`, `${side}K`, `${side}A`, `${side}B`, `${side}N`, `${side}R`];
	board[0] = back(BLACK);
	board[9] = back(RED);
	board[2][1] = `${BLACK}C`;
	board[2][7] = `${BLACK}C`;
	board[7][1] = `${RED}C`;
	board[7][7] = `${RED}C`;
	for (const x of [0, 2, 4, 6, 8]) {
		board[3][x] = `${BLACK}P`;
		board[6][x] = `${RED}P`;
	}
	return board;
}

/**
 * @param board - the position.
 * @returns a deep copy (independent rows).
 */
export function cloneBoard(board) {
	return board.map((row) => row.slice());
}

/**
 * @param x - column.
 * @param y - row.
 * @returns true when the cell is on the board.
 */
export function onBoard(x, y) {
	return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

/**
 * Whether a cell lies in `side`'s palace (九宫).
 *
 * @param x - column.
 * @param y - row.
 * @param side - the side.
 * @returns true when inside the palace.
 */
export function inPalace(x, y, side) {
	if (x < 3 || x > 5) return false;
	return side === RED ? y >= 7 && y <= 9 : y >= 0 && y <= 2;
}

/**
 * Whether a cell is on `side`'s own half (the bishop may not cross the river).
 *
 * @param y - row.
 * @param side - the side.
 * @returns true when the row is on that side's half.
 */
export function ownHalf(y, side) {
	return side === RED ? y >= 5 : y <= 4;
}

/** 马走日的八个方向，附带对应的马腿偏移。 */
const KNIGHT_STEPS = [
	[1, -2, 0, -1], [-1, -2, 0, -1], [1, 2, 0, 1], [-1, 2, 0, 1],
	[2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0],
];

/** 象走田的四个方向，附带象眼偏移。 */
const BISHOP_STEPS = [
	[2, 2, 1, 1], [2, -2, 1, -1], [-2, 2, -1, 1], [-2, -2, -1, -1],
];

/** 车的四个方向。 */
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Pseudo-legal destinations for the piece at `(x, y)`.
 *
 * "Pseudo-legal" means it ignores whether the move leaves one's own king in
 * check; see {@link legalMoves} for the filtered list.
 *
 * @param board - the position.
 * @param x - column.
 * @param y - row.
 * @returns an array of `[x, y]` destinations.
 */
export function movesForPiece(board, x, y) {
	const piece = board[y][x];
	if (piece === null) return [];
	const side = piece[0];
	const type = piece[1];
	const out = [];
	const push = (nx, ny) => {
		if (!onBoard(nx, ny)) return false;
		const target = board[ny][nx];
		if (target !== null && target[0] === side) return false;
		out.push([nx, ny]);
		return target === null;
	};

	switch (type) {
		case TYPES.ROOK:
			for (const [dx, dy] of ORTHO) {
				let nx = x + dx;
				let ny = y + dy;
				while (push(nx, ny)) {
					nx += dx;
					ny += dy;
				}
			}
			break;

		case TYPES.CANNON:
			for (const [dx, dy] of ORTHO) {
				let nx = x + dx;
				let ny = y + dy;
				// 炮走子：空格可走，直到撞上第一个子。
				while (onBoard(nx, ny) && board[ny][nx] === null) {
					out.push([nx, ny]);
					nx += dx;
					ny += dy;
				}
				// 炮吃子：越过炮架后遇到的第一个子，若是敌方则可吃。
				nx += dx;
				ny += dy;
				while (onBoard(nx, ny)) {
					const target = board[ny][nx];
					if (target !== null) {
						if (target[0] !== side) out.push([nx, ny]);
						break;
					}
					nx += dx;
					ny += dy;
				}
			}
			break;

		case TYPES.KNIGHT:
			for (const [dx, dy, lx, ly] of KNIGHT_STEPS) {
				// 马腿：先走的那一格被占住就蹩住了。
				if (board[y + ly]?.[x + lx] !== null && board[y + ly]?.[x + lx] !== undefined) continue;
				push(x + dx, y + dy);
			}
			break;

		case TYPES.BISHOP:
			for (const [dx, dy, ex, ey] of BISHOP_STEPS) {
				const nx = x + dx;
				const ny = y + dy;
				if (!onBoard(nx, ny) || !ownHalf(ny, side)) continue;
				// 象眼。
				if (board[y + ey]?.[x + ex] !== null && board[y + ey]?.[x + ex] !== undefined) continue;
				push(nx, ny);
			}
			break;

		case TYPES.ADVISOR:
			for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
				const nx = x + dx;
				const ny = y + dy;
				if (!inPalace(nx, ny, side)) continue;
				push(nx, ny);
			}
			break;

		case TYPES.KING:
			for (const [dx, dy] of ORTHO) {
				const nx = x + dx;
				const ny = y + dy;
				if (!inPalace(nx, ny, side)) continue;
				push(nx, ny);
			}
			break;

		case TYPES.PAWN: {
			const forward = side === RED ? -1 : 1;
			push(x, y + forward);
			const crossed = side === RED ? y <= 4 : y >= 5;
			if (crossed) {
				push(x - 1, y);
				push(x + 1, y);
			}
			break;
		}

		default:
			break;
	}
	return out;
}

/**
 * Every pseudo-legal move for one side.
 *
 * @param board - the position.
 * @param side - the side to move.
 * @returns `[{ from, to, piece, capture }]`.
 */
export function generateMoves(board, side) {
	const moves = [];
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			const piece = board[y][x];
			if (piece === null || piece[0] !== side) continue;
			for (const [nx, ny] of movesForPiece(board, x, y)) {
				moves.push({ from: [x, y], to: [nx, ny], piece, capture: board[ny][nx] });
			}
		}
	}
	return moves;
}

/**
 * Apply a move in place.
 *
 * @param board - the position (mutated).
 * @param move - `{ from, to }`.
 * @returns the captured piece (or null), for {@link undoMove}.
 */
export function makeMove(board, move) {
	const [fx, fy] = move.from;
	const [tx, ty] = move.to;
	const captured = board[ty][tx];
	board[ty][tx] = board[fy][fx];
	board[fy][fx] = null;
	return captured;
}

/**
 * Undo a move made by {@link makeMove}.
 *
 * @param board - the position (mutated).
 * @param move - the move that was made.
 * @param captured - what {@link makeMove} returned.
 */
export function undoMove(board, move, captured) {
	const [fx, fy] = move.from;
	const [tx, ty] = move.to;
	board[fy][fx] = board[ty][tx];
	board[ty][tx] = captured;
}

/**
 * Locate a side's king.
 *
 * @param board - the position.
 * @param side - the side.
 * @returns `[x, y]`, or null when the king is gone (which only happens in
 *   pseudo-legal search after a king capture).
 */
export function findKing(board, side) {
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			if (board[y][x] === `${side}K`) return [x, y];
		}
	}
	return null;
}

/**
 * Whether `side` is in check right now.
 *
 * Includes the flying-general rule: two kings facing each other down an open
 * file count as check for the side that would be exposed, which is what makes
 * "将帅照面" illegal without a separate rule in the move generator.
 *
 * @param board - the position.
 * @param side - the side to test.
 * @returns true when that side's king is attacked.
 */
export function isInCheck(board, side) {
	const king = findKing(board, side);
	if (king === null) return true;
	const [kx, ky] = king;
	const enemy = side === RED ? BLACK : RED;

	// 车、炮、将（照面）：沿四条直线扫描。
	for (const [dx, dy] of ORTHO) {
		let nx = kx + dx;
		let ny = ky + dy;
		let blockers = 0;
		while (onBoard(nx, ny)) {
			const piece = board[ny][nx];
			if (piece !== null) {
				if (blockers === 0) {
					// 第一个子：车或对将可以将军。
					if (piece === `${enemy}R`) return true;
					if (piece === `${enemy}K` && dx === 0) return true;
					blockers = 1;
				} else {
					// 第二个子：炮可以将军。
					if (piece === `${enemy}C`) return true;
					break;
				}
			}
			nx += dx;
			ny += dy;
		}
	}

	// 马：从将的位置反推马可能在哪（避免写八个方向的重复逻辑）。
	for (const [dx, dy, lx, ly] of KNIGHT_STEPS) {
		const nx = kx + dx;
		const ny = ky + dy;
		if (!onBoard(nx, ny)) continue;
		if (board[ny][nx] !== `${enemy}N`) continue;
		// 蹩马腿：从马的角度看，腿在它朝将方向的那一格。
		if (board[ny + ly]?.[nx + lx] !== null && board[ny + ly]?.[nx + lx] !== undefined) continue;
		return true;
	}

	// 兵/卒：贴身的横向或正面一击。
	const pawnForward = side === RED ? 1 : -1;
	if (board[ky + pawnForward]?.[kx] === `${enemy}P`) return true;
	if (board[ky]?.[kx - 1] === `${enemy}P` || board[ky]?.[kx + 1] === `${enemy}P`) {
		// 侧面只有过河的兵才咬得到。
		const crossed = enemy === RED ? ky <= 4 : ky >= 5;
		if (crossed) return true;
	}

	return false;
}

/**
 * Legal moves: pseudo-legal ones that do not leave one's own king in check.
 *
 * @param board - the position.
 * @param side - the side to move.
 * @returns `[{ from, to, piece, capture }]`.
 */
export function legalMoves(board, side) {
	const out = [];
	for (const move of generateMoves(board, side)) {
		const captured = makeMove(board, move);
		const bad = isInCheck(board, side);
		undoMove(board, move, captured);
		if (!bad) out.push(move);
	}
	return out;
}

/**
 * Game state for the side to move.
 *
 * @param board - the position.
 * @param side - the side to move.
 * @returns `"playing"`, `"check"`, `"checkmate"` or `"stalemate"` (困毙 also loses).
 */
export function gameStatus(board, side) {
	const moves = legalMoves(board, side);
	if (moves.length > 0) return isInCheck(board, side) ? "check" : "playing";
	return isInCheck(board, side) ? "checkmate" : "stalemate";
}

/**
 * Whether a side has any piece besides its king (used for the 60-move draw).
 *
 * @param board - the position.
 * @param side - the side.
 * @returns true when only the king remains.
 */
export function kingOnly(board, side) {
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			const piece = board[y][x];
			if (piece !== null && piece[0] === side && piece[1] !== TYPES.KING) return false;
		}
	}
	return true;
}

/**
 * A compact one-line description of a move, for logs and prompts.
 *
 * @param board - the position **before** the move.
 * @param move - `{ from, to }`.
 * @returns e.g. `炮(h2)→(e2) 吃马`.
 */
export function describeMove(board, move) {
	const piece = board[move.from[1]][move.from[0]];
	const captured = board[move.to[1]][move.to[0]];
	const name = NAMES[piece] ?? piece;
	const label = (cell) => `${"abcdefghi"[cell[0]]}${9 - cell[1]}`;
	return `${name}${label(move.from)}→${label(move.to)}${captured === null ? "" : ` 吃${NAMES[captured] ?? captured}`}`;
}
