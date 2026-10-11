/**
 * build-play.mjs — build the game page the host serves.
 *
 * Produces `lib/play-html.js`, a module exporting one self-contained HTML
 * string (markup + styles + the bundled game script inlined). The host returns
 * that string from `/api/dsh-ai-arcade/play` with `no-store`, which is what
 * makes the game iterable without restarting DSH — see `src/web/app.js` for why
 * the game does not live in the plugin's client bundle.
 *
 * Run with `node tools/build-play.mjs` (or `pnpm build:play`).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outputPath = resolve(root, "lib/play.html");

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#14171d;color:#e6e8ee;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.shell{display:flex;flex-direction:column;height:100%;padding:10px;gap:8px}
.tabs{flex:none;display:flex;gap:6px}
.tabs button{height:29px;padding:0 13px;border:1px solid #3a4150;border-radius:8px;background:transparent;color:#9aa2b1;cursor:pointer;font-size:12.5px}
.tabs button.on{background:#5b8def;border-color:#5b8def;color:#fff;font-weight:600}
.tabs button:not(.on):hover{background:#2a3140;color:#e6e8ee}
.stage{flex:1;min-height:0}
.wrap{display:flex;gap:12px;height:100%}
.left{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}
.title{font-size:15px;font-weight:600}
.seg{display:inline-flex;border:1px solid #3a4150;border-radius:8px;overflow:hidden}
.seg button{height:27px;padding:0 11px;border:0;background:transparent;color:#9aa2b1;cursor:pointer;font-size:12px}
.seg button.on{background:#5b8def;color:#fff;font-weight:600}
.seg button:not(.on):hover{background:#2a3140;color:#e6e8ee}
.speed{display:flex;align-items:center;gap:6px;color:#6b7280;font-size:11px}
.speed input{width:80px;accent-color:#5b8def}
canvas{flex:1;min-height:0;aspect-ratio:1/1;width:auto;max-width:100%;margin:0 auto;border-radius:12px;background:#0d1117;display:block;touch-action:none}
.row{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
button.act{height:33px;padding:0 14px;border:0;border-radius:8px;background:#5b8def;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer}
button.act:hover{background:#6f9bf2}
button.ghost{height:33px;padding:0 13px;border:1px solid #3a4150;border-radius:8px;background:transparent;color:#e6e8ee;font-size:12.5px;cursor:pointer}
button.ghost:hover{background:#2a3140}
.meta{font-size:11px;color:#6b7280;min-height:16px}
.side{flex:none;width:340px;display:flex;flex-direction:column;gap:8px;min-height:0}
.score{flex:none;display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
  border-radius:10px;background:#0d1117;border:1px solid #3a4150}
.score b{font-size:19px;font-variant-numeric:tabular-nums}
.score span{font-size:11px;color:#9aa2b1}
.brains{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
.card{padding:9px 11px;border-radius:10px;background:#0d1117;border:1px solid #3a4150}
.card.you{border-color:#2f7d3a}
.card.ai{border-color:#8c6d1f}
.cardhead{display:flex;align-items:center;gap:8px;font-size:12px;color:#9aa2b1;margin-bottom:6px}
.cardhead select{margin-left:auto;background:#1f2430;color:#e6e8ee;border:1px solid #3a4150;border-radius:6px;font-size:11px;padding:1px 4px}
.cardhead .persona{margin-left:auto}
.dot{width:7px;height:7px;border-radius:50%;background:#5b8def;flex:none}
.dot.busy{background:#e8b339;animation:pulse 1s ease-in-out infinite}
.dot.dead{background:#e5534b}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
.taunt{font-size:13px;line-height:1.5;word-break:break-word;min-height:19px}
.reason{margin-top:5px;font-size:11.5px;color:#8b93a7;white-space:pre-wrap;word-break:break-word;max-height:78px;overflow-y:auto}
.policy{margin-top:6px;font-size:10.5px;color:#6b7280;font-variant-numeric:tabular-nums}
.stream{flex:none;font-size:11px;color:#6b7280;line-height:16px;min-height:16px}
.xq{display:flex;gap:12px;height:100%}
.xq-left{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.xq-left canvas{flex:1;min-height:0;width:100%;border-radius:12px;background:#1a1f27;display:block;touch-action:none;cursor:pointer}
.xq-side{flex:none;width:340px;display:flex;flex-direction:column;gap:8px;min-height:0}
.xq-controls{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;background:#0d1117;border:1px solid #3a4150}
.xq-comment{flex:none;padding:10px;border-radius:10px;background:#0d1117;border:1px solid #3a4150;font-size:13px;line-height:1.55;min-height:58px;color:#e6e8ee}
.xq-log{flex:1;min-height:0;overflow-y:auto;padding:8px 10px;border-radius:10px;background:#0d1117;border:1px solid #3a4150;font-size:12.5px;line-height:1.75}
.xq-move{display:flex;gap:8px}
.xq-no{color:#6b7280;width:34px;flex:none;text-align:right}
.xq-move .red{color:#ff6b6b}
.xq-move .black{color:#c9d1d9}
`;

const MARKUP = `
<div class="shell">
  <div class="tabs" id="tabs"></div>
  <div class="stage" id="stage"></div>
</div>
`;

const result = await build({
	entryPoints: [resolve(root, "src/web/app.js")],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: ["chrome100"],
	external: [],
	// esbuild 默认把非 ASCII 转义成 \uXXXX（charset: "ascii"），中文文案会被打散成
	// 转义序列：体积变大，而且没法用 grep 核对页面里到底有没有那句话。
	charset: "utf8",
	write: false,
	minify: false,
	legalComments: "none",
});

const bundled = result.outputFiles?.[0]?.text;
if (typeof bundled !== "string" || bundled === "") throw new Error("esbuild produced no game script");

// A literal `</script` inside the script would close the tag early.
const safeScript = bundled.replace(/<\/script/gi, "<\\/script");

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>双脑贪吃蛇 · AI 街机厅</title>
<style>${CSS}</style>
</head>
<body>
${MARKUP}
<script>${safeScript}</script>
</body>
</html>
`;

const module = `/* generated by tools/build-play.mjs — edit src/web/ instead */
export const PLAY_HTML = ${JSON.stringify(html)};
`;
void module;

// Written as a plain .html asset, not a JS module: the route reads it from disk
// on every request, so editing the page never requires reloading the plugin
// (an imported constant would be frozen in the module cache, which is exactly
// the trap this whole design exists to avoid).
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, "utf8");
console.log(`wrote ${outputPath} (${html.length} bytes)`);
