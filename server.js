/** Health endpoint: GET / → JSON status (used by Docker/Railway health checks). */
import http from "node:http";
import * as config from "./config.js";
import * as db from "./db.js";
import * as logger from "./logger.js";
import * as runtime from "./runtime.js";

let server = null;

export function start(sessionCount) {
  if (server) return Promise.resolve(server);
  const cfg = config.get();
  const srv = http.createServer((_req, res) => {
    const body = JSON.stringify({
      name: cfg.bot.name,
      dev: cfg.owner.name,
      status: "online",
      uptime: runtime.uptimeSeconds(),
      mode: db.getMode(),
      sessions: sessionCount(),
      ts: new Date().toISOString(),
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    srv.once("error", (e) => {
      logger.warn(`Health server error: ${e.message}`);
      resolve(null);
    });
    srv.listen(cfg.port, "0.0.0.0", () => {
      server = srv;
      logger.ok(`Health server: http://0.0.0.0:${srv.address().port}`);
      resolve(srv);
    });
  });
}

export function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    s.close(() => resolve());
    s.closeAllConnections?.();
  });
}
