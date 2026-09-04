import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { discover } from "./discover.js";
import { withRobot, MOTION_COMMANDS } from "./robot.js";
import { ERROR_CODES } from "./errors.js";

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const failure = (err) => ({
  content: [{ type: "text", text: `error: ${err.message}` }],
  isError: true,
});

const run = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return failure(err);
  }
};

const CAPABILITY_NOTE =
  "This robot exposes mission-level commands only. It cannot be driven, steered, or nudged: " +
  "there is no drive/turn/motor API on wifi Roombas. Its map is rendered cloud-side and is not " +
  "available locally. The robot's MQTT broker accepts exactly ONE connection, so each call " +
  "connects and disconnects; while a call is in flight the iRobot phone app falls back to cloud.";

export function createServer() {
  const server = new McpServer({ name: "irobot-mcp", version: "0.1.0" });

  server.registerTool(
    "roomba_discover",
    {
      title: "Discover Roombas on the LAN",
      description:
        "Broadcast the iRobot UDP probe and list every robot that answers, with its IP, model, " +
        "firmware and blid. Needs no credentials. Use this to check the robot is awake and reachable.",
      inputSchema: {},
    },
    () =>
      run(async () => {
        const found = await discover({ timeoutMs: 5000 });
        if (found.length === 0) {
          throw new Error("No iRobot device answered on UDP :5678. The robot may be off-network or the host may block LAN broadcast.");
        }
        return text(found);
      }),
  );

  server.registerTool(
    "roomba_status",
    {
      title: "Get robot status",
      description:
        "Battery, bin, dock, wifi signal, lifetime counters, and a decoded reading of the current " +
        "mission. Read-only — does not make the robot move. " +
        CAPABILITY_NOTE,
      inputSchema: {},
    },
    () => run(async () => text(await withRobot((r) => r.snapshot()))),
  );

  server.registerTool(
    "roomba_why",
    {
      title: "Explain what the robot is doing or why it stopped",
      description:
        "Decodes cleanMissionStatus into plain language: the mission cycle and phase, the numeric " +
        "error code translated to its meaning (e.g. 6 = stuck near a cliff), and any notReady " +
        "reason that would block a new job. This is the tool to reach for when the robot is not " +
        "doing what someone expected. Read-only.",
      inputSchema: {},
    },
    () =>
      run(async () => {
        const snap = await withRobot((r) => r.snapshot());
        return text({ ...snap.mission, batteryPct: snap.batteryPct, bin: snap.bin });
      }),
  );

  server.registerTool(
    "roomba_command",
    {
      title: "Send a mission command",
      description:
        "Send one mission-level command. Commands that make the robot physically move " +
        `(${[...MOTION_COMMANDS].join(", ")}) require confirm=true, because this is a real machine ` +
        "in someone's home. 'find' only makes it beep and is the safe way to identify it. " +
        CAPABILITY_NOTE,
      inputSchema: {
        command: z
          .enum(["start", "clean", "pause", "stop", "resume", "dock", "find", "evac", "train"])
          .describe("start/clean begin a mission; dock sends it home; find beeps; evac empties the bin"),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true for any command that makes the robot move. Ask the human first."),
      },
    },
    ({ command, confirm }) =>
      run(async () => {
        if (MOTION_COMMANDS.has(command) && confirm !== true) {
          throw new Error(
            `"${command}" makes the robot physically move. Confirm with the person whose home this is, ` +
              `then call again with confirm=true. If you only want to locate the robot, use "find" (it just beeps).`,
          );
        }
        const before = await withRobot(async (r) => {
          const snap = r.snapshot();
          await r.send(command);
          return snap;
        });
        return text({ ok: true, command, stateBefore: before.mission });
      }),
  );

  server.registerTool(
    "roomba_raw_state",
    {
      title: "Dump raw robot state",
      description:
        "The complete unfiltered state object the robot reports over MQTT. Use when the decoded " +
        "status is missing something. Note pose{} is often absent on newer i-series firmware; " +
        "that is normal, not an error. Read-only.",
      inputSchema: {},
    },
    () => run(async () => text(await withRobot((r) => r.state))),
  );

  server.registerTool(
    "roomba_error_codes",
    {
      title: "Look up Roomba error codes",
      description: "The error-code table used to decode cleanMissionStatus.error. No robot connection needed.",
      inputSchema: {
        code: z.number().int().optional().describe("A specific code to look up; omit for the whole table."),
      },
    },
    ({ code }) =>
      run(async () => {
        if (code === undefined) return text(ERROR_CODES);
        const message = ERROR_CODES[code];
        return text(message ? { code, message } : { code, message: `Unknown error code ${code}`, known: false });
      }),
  );

  return server;
}

export async function serve() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
