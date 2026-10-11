#!/bin/sh
# dev-sync.sh — 把源码树同步进 profile 里"正式包名"的插件目录。
#
# ⚠️ 这个脚本**不再**改插件行的 id / name，这是踩过坑之后的结论：
#
#   DSH 的浏览器半边是按**包名**解析的。早先为了热重载服务端代码，我把补丁行的
#   `name` 换成了 `dsh-ai-arcade-dev-<n>`（一个带时间戳的目录名）——服务端确实
#   每次都重载了新代码，但客户端半边再也注册不上，页面上连 🎮 都不出现。这个
#   副作用被掩盖了很久：浏览器当时还在用最早缓存的 bundle，直到**重启 DSH**、
#   缓存被清掉，才暴露成"插件不见了"。
#
# 现在的边界（都是实测出来的）：
#
#   - **改游戏**（src/web、src/client 里的玩法/棋盘/界面）：跑
#       tools/dev-sync.sh --page
#     然后刷新浏览器。**不用重启** —— 游戏页面由宿主路由每次现读磁盘（`no-store`），
#     这正是它快的全部原因。
#
#   - **改服务端半边**（lib/*.js，除 play.html）或 **overlay 壳**（lib/client.js）：
#     需要**重启一次 DSH**。客户端 bundle 的聚合由进程按文件 mtime/ctime/size
#     算 `rev` 并缓存；服务端模块则被 Node 的 ESM 模块缓存扣住。两者都不会因为
#     "把文件换成新的"而自动失效。
#
#   - 本脚本（不带参数）做的是"重启前把代码放到位"：同步 lib/ 与 package.json，
#     并 bump 一次 `devStamp`（那会让 apply() 用新配置重跑，能生效的只有配置）。
#
# 用法：tools/dev-sync.sh [--page]
#   --page  只重新构建并同步游戏页面（日常迭代用，最快）
set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
DST="$PROFILE/node_modules/dsh-ai-arcade"
PATCH="$PROFILE/cordis.patch.yml"
NODE_BIN="${DSH_NODE_BIN:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin}"
if [ -d "$NODE_BIN" ]; then PATH="$NODE_BIN:$PATH"; export PATH; fi

[ -f "$SRC/package.json" ] || { echo "not a plugin tree: $SRC" >&2; exit 1; }
[ -d "$DST" ] || { echo "plugin is not installed at $DST" >&2; exit 1; }

if [ "$1" = "--page" ]; then
	node "$SRC/tools/build-play.mjs"
	cp "$SRC/lib/play.html" "$DST/lib/play.html"
	echo "已更新游戏页面 → $DST/lib/play.html（刷新浏览器即可，无需重启）"
	exit 0
fi

mkdir -p "$DST/lib"
cp -R "$SRC/lib/." "$DST/lib/"
cp "$SRC/package.json" "$DST/"

STAMP="$(date '+%Y-%m-%dT%H:%M:%S%z')"
if grep -q 'devStamp:' "$PATCH" 2>/dev/null; then
	tmp="$(mktemp)"
	sed "s|^\( *devStamp: *\).*$|\1\"$STAMP\"|" "$PATCH" >"$tmp"
	mv "$tmp" "$PATCH"
	echo "devStamp -> $STAMP"
fi

echo "synced -> $DST/lib"
echo
echo "提醒：lib/*.js 或 lib/client.js 的改动需要**重启 DSH** 才生效；"
echo "      只改游戏页面的话用 \`tools/dev-sync.sh --page\` 就够（刷新即可）。"
