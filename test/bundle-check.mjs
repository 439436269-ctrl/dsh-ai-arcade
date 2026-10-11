/**
 * Static self-check for dsh-ai-arcade.
 *
 * No dependencies beyond Node itself — it parses the shipped files the way the
 * loader will and asserts the cross-file contracts that are easy to break by
 * editing one file: the module id, the route constant shared by both halves,
 * and the fact that the browser bundle imports nothing (it cannot: host
 * packages are not resolvable from the browser).
 *
 * Run with `node test/bundle-check.mjs` (or `pnpm test`).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

const results = [];
/**
 * Record one assertion.
 *
 * @param name - what is being asserted.
 * @param ok - whether it held.
 * @param detail - extra context printed on failure.
 */
function check(name, ok, detail = "") {
	results.push({ name, ok: Boolean(ok), detail });
}

const pkg = JSON.parse(read("package.json"));
const client = read("lib/client.js");
const server = read("lib/index.js");
const brain = read("lib/brain.js");
const patch = read("cordis.patch.yml");

// ── identity ────────────────────────────────────────────────────────
check("package name is dsh-ai-arcade", pkg.name === "dsh-ai-arcade", pkg.name);
check("client module id matches the package name", client.includes(`id: "${pkg.name}"`));
check("client half is exported for the web platform", pkg.dsh?.client?.platform === "web");
check(
	"client half injects the UI slot package",
	Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-slots")
);
check("bundle patch is declared", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("compatibility declares the running release", Object.hasOwn(pkg.dsh?.compatibility?.dshReleases ?? {}, "0.2.0-rc.2"));

// ── the browser bundle must stay importless ─────────────────────────
check("client bundle uses the module loader", client.includes("window.__ModuleLoader__.load"));
check("client bundle has no static import", !/^\s*import\s/m.test(client));
check("client bundle requires no host package", !/require\(["']@deepseek-ai/.test(client));
check("client bundle registers a shell.overlay slot", client.includes('"shell.overlay"'));

// ── the route contract across three files ───────────────────────────
// 游戏搬到宿主页面之后，"谁调用 brain 路由"变了：插件客户端 bundle 只是外壳
// （内嵌 play 页面的 iframe），真正的调用者是被构建出来的 lib/play.html。
const routeMatch = server.match(/BRAIN_ROUTE\s*=\s*"([^"]+)"/);
check("server declares the brain route", routeMatch !== null);
// PLAY_ROUTE 住在 lib/play.js（页面路由被拆成了独立模块），不在 index.js。
const playSource = read("lib/play.js");
const playMatch = playSource.match(/PLAY_ROUTE\s*=\s*"([^"]+)"/);
check("server declares the play page route", playMatch !== null);

let page = "";
try {
	page = read("lib/play.html");
} catch {
	page = "";
}
check("built game page exists (run tools/build-play.mjs)", page !== "");
if (routeMatch !== null && playMatch !== null) {
	check("the game page calls the brain route", page.includes(routeMatch[1]), routeMatch[1]);
	check("the overlay shell embeds the play route", client.includes(playMatch[1]), playMatch[1]);
	check(
		"both routes live under the plugin namespace",
		routeMatch[1].startsWith("/api/dsh-ai-arcade/") && playMatch[1].startsWith("/api/dsh-ai-arcade/")
	);
	check("the page reads its asset per request (not imported)", playSource.includes("readFileSync"));
	check("the play page is served no-store", playSource.includes("no-store"));
}
check("game page ships both games", page.includes("双脑贪吃蛇") && page.includes("中国象棋"));

// ── host half wiring ────────────────────────────────────────────────
check("server injects llm", /inject\s*=\s*\[[^\]]*"llm"/.test(server));
check("server injects webServer", /inject\s*=\s*\[[^\]]*"webServer"/.test(server));
check("server registers through webServer.register", server.includes("webServer"));
check("server validates trusted requests", server.includes("isTrustedRequest"));
check("server registers the route inside ctx.effect", server.includes("ctx.effect("));
check("server exports apply()", /export function apply\(/.test(server));
check("server exports a Config schema", /export \{ Config \}/.test(server));

// ── brain seam ──────────────────────────────────────────────────────
check("brain imports the host llm package", brain.includes('from "@deepseek-ai/dsh-llm"'));
check("brain drives ctx.llm.stream", brain.includes("ctx.llm.stream("));
check("brain assembles streamed text", brain.includes("BlockAssembler"));
check("brain can fall back to a discovered model", brain.includes("ctx.llm.listProviders()"));

// ── patch layer ─────────────────────────────────────────────────────
check("patch inserts exactly one row", (patch.match(/^\s*- insert:/gm) ?? []).length === 1);
check("patch row name equals the package name", patch.includes(`name: ${pkg.name}`));
check("patch row id equals the package name", patch.includes(`id: ${pkg.name}`));

// ── syntax: parse both halves the way their runtimes will ───────────
for (const file of ["lib/index.js", "lib/config.js", "lib/brain.js", "lib/trust.js"]) {
	try {
		execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
		check(`${file} parses as ESM`, true);
	} catch (error) {
		check(`${file} parses as ESM`, false, String(error?.stderr ?? error));
	}
}
try {
	// The browser bundle is an IIFE with no module syntax; `new Function` is the
	// closest parse-only check available without a bundler.
	new Function(client);
	check("lib/client.js parses as a script", true);
} catch (error) {
	check("lib/client.js parses as a script", false, String(error?.message ?? error));
}

// ── report ──────────────────────────────────────────────────────────
const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
	console.log(`${entry.ok ? "ok  " : "FAIL"}  ${entry.name}${entry.ok || entry.detail === "" ? "" : `  — ${entry.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
