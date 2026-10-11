/**
 * dsh-ai-arcade — 浏览器半边入口。
 *
 * 整个游戏只做一件事：把 `ArcadePanel` 挂到 `shell.overlay` 上。它不碰宿主
 * 内部、不读凭据、也不直接调模型——模型调用一律经同源 HTTP 路由走宿主
 * （见 `brain.js`），这样凭据留在主进程里。
 *
 * @module src/client/index
 */

import { ArcadePanel } from "./panel.js";

/** 只需要 UI 槽位服务。 */
export const inject = ["slots"];

/**
 * 挂载。
 *
 * @param ctx - client plugin context.
 */
export function apply(ctx) {
	ctx.slots.inject("shell.overlay", () =>
		ctx.slots.register(
			{
				name: "shell.overlay",
				id: "dsh-ai-arcade:overlay",
				order: 110,
				inject: () => ({}),
			},
			ArcadePanel
		)
	);
}
