import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RobotConnection, MOTION_COMMANDS, COMMANDS } from "./robot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(__dirname, "..", "public", "dashboard.html");

/**
 * Local dashboard server. Holds ONE persistent connection to the robot (the
 * broker's only slot) and fans its live state out to browsers over SSE. While
 * this runs, the iRobot phone app is pushed to cloud — that is the hardware's
 * single-connection constraint, surfaced honestly in the UI.
 */
export async function serveDashboard({ port = 8080, overrides = {} } = {}) {
  const robot = new RobotConnection(overrides);
  await robot.connect();

  const clients = new Set();
  let latest = robot.snapshot();
  robot.subscribe((snap) => {
    latest = snap;
    const payload = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) res.write(payload);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(PAGE, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(latest)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/command") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { command, confirm } = JSON.parse(body || "{}");
          if (!COMMANDS.includes(command)) {
            res.writeHead(400, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: `Unknown command "${command}"` }));
          }
          if (MOTION_COMMANDS.has(command) && confirm !== true) {
            res.writeHead(409, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: `"${command}" moves the robot; confirm required.` }));
          }
          await robot.send(command);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, command }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(port, resolve));
  const url = `http://localhost:${port}`;
  console.error(`irobot dashboard on ${url} — holding the robot's single connection slot (your phone app will fall back to cloud).`);

  const shutdown = () => {
    server.close();
    robot.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { url, server, robot };
}
