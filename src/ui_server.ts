#!/usr/bin/env bun
import { join } from "node:path";

// Dedicated UI server.
//
// Binds 0.0.0.0 by default so the dashboard is reachable on the network, on the
// port directly adjacent to the Orchestra HTTP API (API port + 1). It serves the
// static dashboard and reverse-proxies every other request — including the SSE
// event streams — to the loopback API server, so the API itself can stay bound to
// 127.0.0.1 and the browser only ever talks to one same-origin port.

const UI_FILE = join(import.meta.dir, "ui", "index.html");

const apiHost = process.env.ORCHESTRA_API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.ORCHESTRA_PORT ?? "5751");
const apiBase = `http://${apiHost}:${apiPort}`;

const host = process.env.ORCHESTRA_UI_HOST ?? "0.0.0.0";
const port = Number(process.env.ORCHESTRA_UI_PORT ?? String(apiPort + 1));

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: 0, // keep SSE proxy connections open
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/ui/")) {
      const file = Bun.file(UI_FILE);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("UI not found", { status: 404 });
    }

    // Reverse-proxy everything else to the local API (streams SSE bodies through).
    const target = apiBase + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("connection");

    const init: RequestInit = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }

    try {
      const upstream = await fetch(target, init);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: `ui proxy: ${error instanceof Error ? error.message : String(error)} (is the API server at ${apiBase} running?)` }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  },
});

console.log(`orchestra ui listening on http://${server.hostname}:${server.port}  ->  proxying ${apiBase}`);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
