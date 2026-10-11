/**
 * 街机厅外壳。
 *
 * 这里**只有窗口**：一枚浮动按钮 + 一个 iframe，游戏本体由宿主在
 * `/api/dsh-ai-arcade/play` 上提供（`no-store`）。
 *
 * 为什么这么薄：DSH 把插件的 browser 半边聚合成一个带 `immutable` 一年强缓存
 * 的响应，服务端也缓存这个聚合，所以**改这个文件的代码必须重启 DSH 才生效**。
 * 把游戏放进 iframe 之后，玩法、棋盘、AI 面板改多少都不用碰这里——加新游戏
 * 也只是页面里多一个 tab。
 *
 * @module src/client/panel
 */

import React, { useEffect, useState } from "react";

const h = React.createElement;

/** 游戏页面路由（由宿主提供）。 */
const PLAY_ROUTE = "/api/dsh-ai-arcade/play";

const TAG_ID = "dsh-ai-arcade/arcade.css";

const CSS = [
	".dsha_btn{box-sizing:border-box;position:fixed;left:16px;bottom:72px;z-index:2147483000;height:44px;min-width:44px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:22px;background:#1f2430;color:#e6e8ee;box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer;user-select:none;font-size:16px;line-height:20px}",
	".dsha_btn:hover{background:#2a3140}",
	".dsha_panel{box-sizing:border-box;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483000;width:min(96vw,1080px);height:min(90vh,720px);display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:16px;background:#1f2430;color:#e6e8ee;box-shadow:0 20px 60px rgba(0,0,0,.55);font-size:13px}",
	".dsha_bar{flex:none;display:flex;align-items:center;gap:8px}",
	".dsha_title{font-size:14px;font-weight:600;line-height:20px}",
	".dsha_tag{font-size:11px;color:#6b7280}",
	".dsha_ghost{margin-left:auto;box-sizing:border-box;height:26px;padding:0 10px;border:1px solid #3a4150;border-radius:6px;background:transparent;color:#9aa2b1;cursor:pointer;font-size:12px}",
	".dsha_ghost+.dsha_ghost{margin-left:0}",
	".dsha_ghost:hover{background:#2a3140;color:#e6e8ee}",
	".dsha_frame{flex:1;min-height:0;width:100%;border:1px solid #3a4150;border-radius:12px;background:#14171d;display:block}",
].join("");

/** 插入样式表一次。 */
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return;
	const style = document.createElement("style");
	style.setAttribute("data-plugin-css", TAG_ID);
	style.textContent = CSS;
	document.head.appendChild(style);
}

/**
 * 街机厅窗口。
 *
 * @returns the React element tree.
 */
export function ArcadePanel() {
	const [open, setOpen] = useState(false);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		ensureStyles();
	}, []);

	if (!open) {
		return h("button", { className: "dsha_btn", title: "AI 街机厅", onClick: () => setOpen(true) }, "🎮");
	}

	return h("div", { className: "dsha_panel" }, [
		h("div", { className: "dsha_bar", key: "bar" }, [
			h("span", { className: "dsha_title", key: "t" }, "AI 街机厅"),
			h("span", { className: "dsha_tag", key: "tag" }, "双脑贪吃蛇"),
			h("button", { className: "dsha_ghost", key: "reload", onClick: () => setNonce((value) => value + 1) }, "重新载入"),
			h("button", { className: "dsha_ghost", key: "close", onClick: () => setOpen(false) }, "收起 ✕"),
		]),
		h("iframe", {
			className: "dsha_frame",
			key: nonce,
			src: `${PLAY_ROUTE}?v=${nonce}`,
			title: "AI 街机厅",
		}),
	]);
}
