/**
 * 双脑贪吃蛇 —— 游戏引擎（纯规则，不碰 DOM、不碰网络）。
 *
 * 三条设计约束，都是从实测里逼出来的：
 *
 *  1. **每一步必须是毫秒级的**。模型单次往返 0.8–2 秒，所以模型永远不决定
 *     "这一步怎么走"——它只出一张**策略卡**（目标/激进程度/风险偏好），
 *     具体走法由这里的 `chooseDirection` 每 tick 算一次。
 *  2. **宁可平庸也不能卡**。模型没回复就用上一张卡；一直没回复就用默认策略。
 *     引擎在任何情况下都不会等待网络。
 *  3. **规则要可复现**。`step()` 是确定性的，随机只出现在食物落点和低难度
 *     的失误率上，且都走同一个注入的 `rand`，方便测试时固定种子。
 *
 * @module src/client/games/snake
 */

/** Board is square; `GRID × GRID` cells. */
export const GRID = 20;

/** Direction name → `[dx, dy]` in grid cells (`y` grows downward). */
export const DIRS = Object.freeze({
	up: Object.freeze([0, -1]),
	down: Object.freeze([0, 1]),
	left: Object.freeze([-1, 0]),
	right: Object.freeze([1, 0]),
});

const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };

/** A策略卡 that makes a snake behave reasonably before the model says anything. */
export const DEFAULT_POLICY = Object.freeze({
	target: "food",
	aggression: 0.6,
	risk: 0.3,
	reason: "",
	taunt: "",
});

/**
 * @param x - grid column.
 * @param y - grid row.
 * @returns a stable key for sets ("x,y").
 */
function key(x, y) {
	return `${x},${y}`;
}

/**
 * @param a - `[x, y]`.
 * @param b - `[x, y]`.
 * @returns Manhattan distance.
 */
function manhattan(a, b) {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * @param head - `[x, y]`.
 * @param dir - a key of {@link DIRS}.
 * @returns the neighbouring cell in that direction.
 */
function ahead(head, dir) {
	const [dx, dy] = DIRS[dir];
	return [head[0] + dx, head[1] + dy];
}

/**
 * Every cell currently covered by a living snake's body.
 *
 * @param game - the game state.
 * @param options - `dropTails` treats each tail cell as free, because both tails
 *   move on the same tick (a snake may follow its own tail safely).
 * @returns a `Set` of cell keys.
 */
function occupied(game, options = {}) {
	const { dropTails = false } = options;
	const cells = new Set();
	for (const snake of game.snakes) {
		if (!snake.alive) continue;
		const body = dropTails ? snake.body.slice(0, -1) : snake.body;
		for (const [x, y] of body) cells.add(key(x, y));
	}
	return cells;
}

/**
 * Flood fill from a cell, counting how much room is reachable.
 *
 * This is what keeps the snake from happily sealing itself into a corner: a move
 * that leaves `space` cells of room scores far better than one that leaves two.
 *
 * @param game - the game state.
 * @param from - `[x, y]` starting cell (already validated as free).
 * @param extraBlocked - additional cell keys to treat as walls.
 * @param cap - stop counting past this many cells (enough to rank moves).
 * @returns the number of reachable free cells, capped.
 */
function spaceFrom(game, from, extraBlocked, cap = 60) {
	const blocked = occupied(game, { dropTails: true });
	for (const cell of extraBlocked) blocked.add(cell);
	blocked.delete(key(from[0], from[1]));
	const seen = new Set([key(from[0], from[1])]);
	const queue = [from];
	while (queue.length > 0 && seen.size < cap) {
		const [x, y] = queue.pop();
		for (const dir of Object.keys(DIRS)) {
			const [nx, ny] = ahead([x, y], dir);
			if (nx < 0 || ny < 0 || nx >= game.grid || ny >= game.grid) continue;
			const k = key(nx, ny);
			if (seen.has(k) || blocked.has(k)) continue;
			seen.add(k);
			queue.push([nx, ny]);
			if (seen.size >= cap) break;
		}
	}
	return seen.size;
}

/**
 * Pick a free cell for the next piece of food.
 *
 * @param game - the game state.
 * @param rand - `() => number` in `[0, 1)`.
 * @returns the new food cell, or `null` when the board is full.
 */
export function spawnFood(game, rand) {
	const taken = occupied(game, { dropTails: true });
	taken.add(key(game.food?.[0] ?? -1, game.food?.[1] ?? -1));
	const free = [];
	for (let y = 0; y < game.grid; y += 1) {
		for (let x = 0; x < game.grid; x += 1) {
			if (!taken.has(key(x, y))) free.push([x, y]);
		}
	}
	if (free.length === 0) return null;
	return free[Math.floor(rand() * free.length)];
}

/**
 * Create a fresh game.
 *
 * @param options - `grid` (default {@link GRID}) and `rand` (default `Math.random`).
 * @returns the initial game state.
 */
export function createGame(options = {}) {
	const grid = options.grid ?? GRID;
	const rand = options.rand ?? Math.random;
	const midY = Math.floor(grid / 2);
	const game = {
		grid,
		rand,
		tick: 0,
		over: false,
		winner: null,
		food: null,
		// Both snakes start on the same row, facing each other: symmetric, so a
		// difference in outcome is the brains' fault and not the setup's.
		snakes: [
			createSnake("you", "蓝蛇（你）", [[3, midY], [2, midY], [1, midY]], "right"),
			createSnake("ai", "黄蛇（AI）", [[grid - 4, midY], [grid - 3, midY], [grid - 2, midY]], "left"),
		],
		events: [],
	};
	game.food = spawnFood(game, rand) ?? [Math.floor(grid / 2), midY];
	return game;
}

/**
 * @param id - stable snake id.
 * @param label - display name.
 * @param body - cells, head first.
 * @param dir - initial direction.
 * @returns a snake record.
 */
function createSnake(id, label, body, dir) {
	return {
		id,
		label,
		body,
		dir,
		pendingDir: null,
		alive: true,
		score: 0,
		policy: { ...DEFAULT_POLICY },
		policyReason: "",
		policyTaunt: "",
		policyAt: 0,
		lastThought: "",
	};
}

/**
 * The head cell of a snake.
 *
 * @param snake - a snake record.
 * @returns `[x, y]`.
 */
export function headOf(snake) {
	return snake.body[0];
}

/**
 * Whether a direction is legal for a snake to turn into right now.
 *
 * @param snake - a snake record.
 * @param dir - candidate direction.
 * @returns true when it is not a 180° reversal.
 */
function turnAllowed(snake, dir) {
	if (snake.body.length > 1 && dir === OPPOSITE[snake.dir]) return false;
	return true;
}

/**
 * Rank the legal moves for one snake.
 *
 * @param game - the game state.
 * @param snake - the snake to move.
 * @param policy - the strategy card currently in force.
 * @returns scored candidates, best first (empty when every move dies).
 */
export function rankMoves(game, snake, policy = DEFAULT_POLICY) {
	const head = headOf(snake);
	const blocked = occupied(game, { dropTails: true });
	const rival = game.snakes.find((other) => other.id !== snake.id && other.alive);
	const rivalHead = rival ? headOf(rival) : [game.grid - 1, game.grid - 1];
	const center = [Math.floor(game.grid / 2), Math.floor(game.grid / 2)];
	const target =
		policy.target === "center" ? center : policy.target === "block" && rival ? rivalHead : game.food;

	const candidates = [];
	for (const dir of Object.keys(DIRS)) {
		if (!turnAllowed(snake, dir)) continue;
		const next = ahead(head, dir);
		const [x, y] = next;
		if (x < 0 || y < 0 || x >= game.grid || y >= game.grid) continue;
		if (blocked.has(key(x, y))) continue;

		const room = spaceFrom(game, next, []);
		const dist = manhattan(next, target ?? center);
		// Room dominates: a starving snake that survives can still eat, a fat
		// snake in a sealed pocket cannot. `risk` buys back some appetite.
		const appetite = 0.6 + policy.aggression * 1.2 + policy.risk * 0.8;
		let score = Math.min(room, 55) * 1.6 - dist * appetite * 1.8;
		// Mild preference for the middle: edges are where snakes die.
		score -= manhattan(next, center) * 0.05;
		candidates.push({ dir, next, score, room, dist });
	}
	candidates.sort((a, b) => b.score - a.score);
	return candidates;
}

/**
 * Decide one snake's next direction locally — the millisecond path that keeps
 * the game smooth no matter what the model is doing.
 *
 * @param game - the game state.
 * @param snake - the snake to move.
 * @param policy - the strategy card currently in force.
 * @returns a direction name (falls back to the current heading when trapped).
 */
export function chooseDirection(game, snake, policy = DEFAULT_POLICY) {
	const ranked = rankMoves(game, snake, policy);
	if (ranked.length === 0) return snake.dir;
	// A little noise keeps low-difficulty/same-policy snakes from looping forever.
	if (ranked.length > 1 && game.rand() < 0.06) return ranked[1].dir;
	return ranked[0].dir;
}

/**
 * The direction a snake will actually take this tick: a queued player input if
 * one is legal, otherwise the local decision.
 *
 * @param game - the game state.
 * @param snake - the snake to move.
 * @returns a direction name.
 */
function resolveDirection(game, snake) {
	if (snake.pendingDir !== null && turnAllowed(snake, snake.pendingDir)) {
		const queued = snake.pendingDir;
		snake.pendingDir = null;
		return queued;
	}
	snake.pendingDir = null;
	return chooseDirection(game, snake, snake.policy);
}

/**
 * Advance the game by exactly one tick.
 *
 * Both snakes move simultaneously; wall/self/rival collisions and head-on
 * crashes are resolved from the pre-move snapshot, so no snake gets an
 * accidental first-mover advantage.
 *
 * @param game - the game state (mutated in place).
 * @returns the list of events produced this tick (`eat`, `die`, `over`).
 */
export function step(game) {
	if (game.over) return [];
	game.tick += 1;
	game.events = [];

	const living = game.snakes.filter((snake) => snake.alive);
	const intents = living.map((snake) => ({ snake, dir: resolveDirection(game, snake) }));
	const blocked = occupied(game, { dropTails: true });
	const heads = new Map();
	for (const intent of intents) {
		const next = ahead(headOf(intent.snake), intent.dir);
		heads.set(intent.snake.id, next);
	}

	/**
	 * Whether a snake's intended move kills it.
	 *
	 * @param intent - `{ snake, dir }`.
	 * @returns true when the move is fatal.
	 */
	const dies = (intent) => {
		const [x, y] = heads.get(intent.snake.id);
		if (x < 0 || y < 0 || x >= game.grid || y >= game.grid) return true;
		if (blocked.has(key(x, y))) return true;
		// Head-on: two snakes aiming at the same cell, or swapping cells.
		for (const other of intents) {
			if (other.snake.id === intent.snake.id) continue;
			const otherHead = heads.get(other.snake.id);
			if (otherHead[0] === x && otherHead[1] === y) return true;
			const otherNow = headOf(other.snake);
			if (otherHead[0] === headOf(intent.snake)[0] && otherHead[1] === headOf(intent.snake)[1]) {
				if (otherNow[0] === x && otherNow[1] === y) return true;
			}
		}
		return false;
	};

	const survivors = [];
	for (const intent of intents) {
		if (dies(intent)) {
			intent.snake.alive = false;
			game.events.push({ type: "die", snake: intent.snake.id });
		} else {
			survivors.push(intent);
		}
	}

	for (const { snake, dir } of survivors) {
		const next = ahead(headOf(snake), dir);
		snake.dir = dir;
		snake.body.unshift(next);
		if (game.food !== null && next[0] === game.food[0] && next[1] === game.food[1]) {
			snake.score += 1;
			game.events.push({ type: "eat", snake: snake.id });
			game.food = spawnFood(game, game.rand);
		} else {
			snake.body.pop();
		}
	}

	if (game.food === null) {
		game.over = true;
		game.winner = null;
		game.events.push({ type: "over", reason: "board-full" });
		return game.events;
	}

	const aliveNow = game.snakes.filter((snake) => snake.alive);
	if (aliveNow.length <= 1) {
		game.over = true;
		game.winner = aliveNow.length === 1 ? aliveNow[0].id : null;
		game.events.push({ type: "over", reason: "elimination" });
	}
	return game.events;
}

/**
 * Serialise the board for a model prompt: compact, deterministic, and readable
 * enough that the model can reason about "what is near what".
 *
 * @param game - the game state.
 * @param snake - the snake whose prompt this is.
 * @returns a short multi-line description.
 */
export function describeBoard(game, snake) {
	const rival = game.snakes.find((other) => other.id !== snake.id);
	const lines = [
		`棋盘 ${game.grid}x${game.grid}（左上角是 (0,0)，x 向右，y 向下）`,
		`你（${snake.label}）蛇头 ${fmt(headOf(snake))}，朝${zh(snake.dir)}，长 ${snake.body.length}，已吃 ${snake.score}`,
	];
	if (rival) {
		lines.push(
			`对手（${rival.label}）蛇头 ${fmt(headOf(rival))}，朝${zh(rival.dir)}，长 ${rival.body.length}，已吃 ${rival.score}`
		);
	}
	lines.push(`食物 ${fmt(game.food)}`);
	lines.push(`回合 ${game.tick}`);
	return lines.join("\n");
}

/**
 * @param cell - `[x, y]`.
 * @returns `"(x,y)"`.
 */
function fmt(cell) {
	return `(${cell?.[0] ?? "?"},${cell?.[1] ?? "?"})`;
}

/**
 * @param dir - a direction name.
 * @returns its Chinese label.
 */
function zh(dir) {
	return { up: "上", down: "下", left: "左", right: "右" }[dir] ?? dir;
}
