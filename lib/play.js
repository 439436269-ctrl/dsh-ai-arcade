/**
 * The game page route.
 *
 * Serves the self-contained game HTML on a same-origin path; the overlay panel
 * embeds it in an iframe.
 *
 * Three details matter, and all three exist because of one measured fact: DSH
 * serves plugin client bundles as `immutable` for a year AND caches the
 * aggregate server-side, so anything inside the plugin's browser bundle can only
 * be updated by restarting the harness. This page therefore lives outside that
 * bundle — and to stay iterable it must not be captured at import time either:
 *
 *  - the HTML is **read from disk on every request** (not imported as a module
 *    constant, which would be frozen in the ESM cache exactly like the bundle);
 *  - the response is `no-store`, so the browser re-asks every time;
 *  - the same trust fence as the brain route guards it, because this page can
 *    spend the user's model credits and the DSH web UI may be reachable through
 *    a LAN bind, a reverse proxy or a tunnel.
 *
 * @module dsh-ai-arcade/play
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isTrustedRequest } from "./trust.js";

/** Exact path served by this plugin. */
export const PLAY_ROUTE = "/api/dsh-ai-arcade/play";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = join(here, "play.html");

/**
 * Read the built game page.
 *
 * @returns the HTML, or null when the asset is missing (build not run).
 */
function readPage() {
	try {
		return readFileSync(PAGE_FILE, "utf8");
	} catch {
		return null;
	}
}

/**
 * Register the game page route.
 *
 * @param ctx - host plugin context.
 * @returns a disposer (no-op when the host has no web server).
 */
export function registerPlayRoute(ctx) {
	const server = ctx.get("webServer");
	if (server === undefined || typeof server.register !== "function") {
		console.warn("[dsh-ai-arcade] no webServer service — play route not registered");
		return () => {};
	}
	const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
	const dispose = server.register({
		kind: "exact",
		path: PLAY_ROUTE,
		handler: (req, res) => {
			if (!isTrustedRequest(req, trustedHosts)) {
				res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
				res.end("forbidden");
				return;
			}
			const page = readPage();
			if (page === null) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
				res.end("play.html is missing — run `node tools/build-play.mjs`");
				return;
			}
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store, must-revalidate",
			});
			res.end(page);
		},
	});
	console.log(`[dsh-ai-arcade] play page ready at ${PLAY_ROUTE} (served from ${PAGE_FILE})`);
	return () => {
		if (typeof dispose === "function") dispose();
	};
}
