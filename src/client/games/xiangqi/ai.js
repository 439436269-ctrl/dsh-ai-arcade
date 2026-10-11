/**
 * 象棋引擎的"棋力"部分：局面评估 + alpha-beta 搜索。
 *
 * 一个刻意的分工：**棋力全部来自这里，模型不参与算棋**。原因很直接——让
 * LLM 直接给走法，它会走出马蹩腿、炮翻空、将帅照面这类非法棋；就算合法，
 * 一个几百行的 alpha-beta 也能轻松赢它。所以模型的作用被限制在"从本地给出的
 * 候选里挑一个 + 说理由"，见 `brain` 那一侧。
 *
 * 搜索是 negamax + alpha-beta，内部走**伪合法**走法（不做自将过滤，靠"吃到将
 * 就返回绝杀分"剪枝，这是标准做法，比每步都做合法性检查快一个数量级）。根节点
 * 与界面才用真正的合法走法。
 *
 * @module src/client/games/xiangqi/ai
 */

import {
	BLACK,
	HEIGHT,
	RED,
	TYPES,
	VALUES,
	WIDTH,
	findKing,
	generateMoves,
	isInCheck,
	legalMoves,
	makeMove,
	undoMove,
} from "./rules.js";

/** 绝杀分：比任何子力总和都大，再按"越早将死越好"做层次区分。 */
const MATE = 1_000_000;

/** 兵/卒过河后的额外价值。 */
const CROSSED_PAWN_BONUS = 90;

/** 马炮车的中心位置加成（越靠中间越灵活）。 */
const CENTER_BONUS = [
	[0, 1, 2, 3, 3, 3, 2, 1, 0],
	[1, 2, 4, 5, 5, 5, 4, 2, 1],
	[2, 4, 6, 7, 7, 7, 6, 4, 2],
	[3, 5, 7, 8, 8, 8, 7, 5, 3],
	[3, 5, 7, 8, 8, 8, 7, 5, 3],
	[3, 5, 7, 8, 8, 8, 7, 5, 3],
	[3, 5, 7, 8, 8, 8, 7, 5, 3],
	[2, 4, 6, 7, 7, 7, 6, 4, 2],
	[1, 2, 4, 5, 5, 5, 4, 2, 1],
	[0, 1, 2, 3, 3, 3, 2, 1, 0],
];

/**
 * @param side - a side constant.
 * @returns the opposing side.
 */
export function other(side) {
	return side === RED ? BLACK : RED;
}

/**
 * Static evaluation, from `side`'s point of view.
 *
 * @param board - the position.
 * @param side - the side to evaluate for.
 * @returns a signed score (positive = good for `side`).
 */
export function evaluate(board, side) {
	let score = 0;
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			const piece = board[y][x];
			if (piece === null) continue;
			const type = piece[1];
			const sign = piece[0] === side ? 1 : -1;
			let value = VALUES[type];
			if (type === TYPES.PAWN) {
				const crossed = piece[0] === RED ? y <= 4 : y >= 5;
				if (crossed) value += CROSSED_PAWN_BONUS;
				// 越逼近对方底线越值钱。
				value += (piece[0] === RED ? 9 - y : y) * 6;
			} else if (type === TYPES.KNIGHT || type === TYPES.CANNON || type === TYPES.ROOK) {
				value += CENTER_BONUS[y][x];
			}
			score += sign * value;
		}
	}
	return score;
}

/**
 * Order moves so alpha-beta prunes early: captures first, biggest victim first.
 *
 * @param moves - generated moves.
 * @returns a new, sorted array.
 */
function orderMoves(moves) {
	return moves
		.map((move) => {
			const victim = move.capture === null ? 0 : VALUES[move.capture[1]];
			const attacker = VALUES[move.piece[1]];
			// MVV-LVA：吃大子、用小子的走法先试。
			return { move, rank: victim * 10 - attacker };
		})
		.sort((a, b) => b.rank - a.rank)
		.map((entry) => entry.move);
}

/**
 * Negamax with alpha-beta pruning over pseudo-legal moves.
 *
 * @param board - the position (mutated and restored).
 * @param side - the side to move.
 * @param depth - remaining plies.
 * @param alpha - lower bound.
 * @param beta - upper bound.
 * @param deadline - epoch ms after which the search stops early.
 * @returns the score from `side`'s point of view.
 */
function negamax(board, side, depth, alpha, beta, deadline) {
	if (depth <= 0) return evaluate(board, side);
	if (Date.now() > deadline) return evaluate(board, side);

	const moves = orderMoves(generateMoves(board, side));
	if (moves.length === 0) return -MATE + (10 - depth); // 无子可动：输

	let best = -Infinity;
	for (const move of moves) {
		const captured = makeMove(board, move);
		// 吃掉了对方的将：这一支已经结束，不必再往下算。
		if (captured !== null && captured[1] === TYPES.KING) {
			undoMove(board, move, captured);
			return MATE - (10 - depth);
		}
		const score = -negamax(board, other(side), depth - 1, -beta, -alpha, deadline);
		undoMove(board, move, captured);
		if (score > best) best = score;
		if (best > alpha) alpha = best;
		if (alpha >= beta) break;
	}
	return best;
}

/**
 * Rank every legal move for a side.
 *
 * This is the **only** thing the model is allowed to choose from, which is what
 * makes an illegal AI move impossible.
 *
 * @param board - the position.
 * @param side - the side to move.
 * @param options - `depth` (plies), `timeMs` (soft budget), `limit` (how many
 *   candidates to return).
 * @returns `[{ move, score, description }]`, best first.
 */
export function findBestMoves(board, side, options = {}) {
	const depth = Math.max(1, Math.min(5, options.depth ?? 2));
	const timeMs = Math.max(200, options.timeMs ?? 1500);
	const limit = Math.max(1, options.limit ?? 5);
	const deadline = Date.now() + timeMs;

	const moves = legalMoves(board, side);
	if (moves.length === 0) return [];

	const scored = moves.map((move) => {
		const captured = makeMove(board, move);
		const score = -negamax(board, other(side), depth - 1, -Infinity, Infinity, deadline);
		undoMove(board, move, captured);
		return { move, score };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

/**
 * Pick one move at a difficulty level.
 *
 * The level drives two things at once, because "a weaker opponent" is not just
 * a shallower search — it is also a more fallible one:
 *   - `depth` 1..5 by level;
 *   - a blunder chance that sometimes picks 2nd/3rd best even when the engine
 *     can see better, so low levels feel human rather than merely blind.
 *
 * @param board - the position.
 * @param side - the side to move.
 * @param level - 1..10 slider value.
 * @param options - `rand` (`() => number`), `timeMs`.
 * @returns `{ move, score, candidates }` or null when there is no legal move.
 */
export function pickMove(board, side, level, options = {}) {
	const rand = options.rand ?? Math.random;
	const clamped = Math.max(1, Math.min(10, Math.round(level)));
	const depth = Math.max(1, Math.min(5, Math.ceil(clamped / 2)));
	const candidates = findBestMoves(board, side, {
		depth,
		limit: clamped <= 3 ? 4 : clamped <= 7 ? 3 : 2,
		timeMs: options.timeMs ?? 1200,
	});
	if (candidates.length === 0) return null;

	// 低级：经常莫名其妙地走次优；中级：偶尔；高级：永远选最好。
	const blunder = clamped <= 3 ? 0.45 : clamped <= 6 ? 0.18 : clamped <= 8 ? 0.05 : 0;
	if (candidates.length > 1 && rand() < blunder) {
		const index = 1 + Math.floor(rand() * (candidates.length - 1));
		return { ...candidates[index], candidates };
	}
	return { ...candidates[0], candidates };
}

/**
 * A cheap sanity check used by the UI: is this side's king currently attacked?
 *
 * @param board - the position.
 * @param side - the side.
 * @returns true when in check.
 */
export function inCheck(board, side) {
	return findKing(board, side) === null || isInCheck(board, side);
}
