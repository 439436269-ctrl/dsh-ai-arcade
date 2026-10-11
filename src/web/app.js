/**
 * AI 街机厅的外壳：顶部一个游戏选择条，下面一块舞台。
 *
 * 它自己不玩游戏——只负责"同一时刻挂一个 view，切换时先卸载再挂载"。加新游戏
 * 就是往 `GAMES` 里加一行，别的都不用动；因为整页是宿主每次现读现发的
 * （`no-store`），改完刷新浏览器即可，不需要重启 DSH。
 *
 * @module src/web/app
 */

import { mount as mountSnake } from "./snake-view.js";
import { mount as mountXiangqi } from "./xiangqi-view.js";

/** 已接入的游戏。 */
const GAMES = [
	{ id: "snake", label: "🐍 双脑贪吃蛇", mount: mountSnake },
	{ id: "xiangqi", label: "♟ 中国象棋", mount: mountXiangqi },
];

const tabs = document.getElementById("tabs");
const stage = document.getElementById("stage");
if (tabs === null || stage === null) throw new Error("shell markup is missing #tabs / #stage");

/** 当前 view 的卸载函数。 */
let dispose = null;
/** 当前游戏 id。 */
let active = null;

/**
 * 切到某个游戏。
 *
 * @param id - entry in {@link GAMES}.
 */
function select(id) {
	if (active === id) return;
	active = id;
	if (dispose !== null) {
		dispose();
		dispose = null;
	}
	stage.innerHTML = "";
	const entry = GAMES.find((game) => game.id === id);
	if (entry === undefined) return;
	dispose = entry.mount(stage);
	for (const button of tabs.querySelectorAll("button")) {
		button.classList.toggle("on", button.dataset.game === id);
	}
}

for (const game of GAMES) {
	const button = document.createElement("button");
	button.dataset.game = game.id;
	button.textContent = game.label;
	button.addEventListener("click", () => select(game.id));
	tabs.appendChild(button);
}

select(GAMES[0].id);
