import { discover } from "./discover.js";
import { pair } from "./pair.js";
import { readConfig, CONFIG_FILE } from "./config.js";
import { RobotConnection, withRobot } from "./robot.js";
import { serveDashboard } from "./server.js";
import { explain } from "./errors.js";

const USAGE = `roomba — control a local-network iRobot Roomba

  roomba discover            find robots on the LAN (no credentials needed)
  roomba pair                extract the local password (hold HOME/DOCK until it chirps)
  roomba status              battery, bin, dock, mission state
  roomba why                 plain-language explanation of what it is doing / why it stopped
  roomba start               begin a cleaning mission        [MOVES]
  roomba pause               pause the current mission
  roomba resume              resume a paused mission         [MOVES]
  roomba stop                end the current mission
  roomba dock                send it home                    [MOVES]
  roomba find                make it beep so you can find it
  roomba evac                empty the bin into the base     [MOVES]
  roomba watch               stream live state until ctrl-c
  roomba dashboard           local web dashboard (live state + controls)
  roomba raw                 dump the full raw state object

Options:
  --json                     machine-readable output
  --ip <addr>                override the robot's address
  --timeout <sec>            connection timeout (default 20)

This hardware exposes mission-level commands only. There is no drive, turn, or
motor control — see the README.`;

function parseArgs(argv) {
  const args = { _: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--ip") args.ip = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]) * 1000;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

const out = (args, obj, human) => console.log(args.json ? JSON.stringify(obj, null, 2) : human);

function formatStatus(snap) {
  const lines = [
    `${snap.name ?? "roomba"}${snap.sku ? ` (${snap.sku})` : ""}`,
    `  ${snap.mission.summary}`,
    `  battery   ${snap.batteryPct != null ? `${snap.batteryPct}%` : "not reported"}`,
    `  bin       ${snap.bin ? `${snap.bin.present ? "present" : "MISSING"}${snap.bin.full ? ", FULL" : ""}` : "not reported"}`,
    `  dock      ${snap.dockKnown === null ? "not reported" : snap.dockKnown ? "known" : "unknown"}`,
  ];
  if (snap.signal) lines.push(`  wifi      rssi ${snap.signal.rssi} / snr ${snap.signal.snr}`);
  if (snap.mission.minutesRunning) lines.push(`  running   ${snap.mission.minutesRunning} min, ${snap.mission.sqft ?? "?"} sqft`);
  if (snap.lifetime) lines.push(`  lifetime  ${snap.lifetime.missions ?? "?"} missions, stuck ${snap.lifetime.stuck}x, picked up ${snap.lifetime.pickups}x`);
  if (snap.lastCommand?.command) lines.push(`  last cmd  ${snap.lastCommand.command}`);
  return lines.join("\n");
}

async function cmdDiscover(args) {
  const found = await discover({ timeoutMs: 5000, target: args.ip });
  if (found.length === 0) {
    throw new Error(
      "No iRobot device answered on UDP :5678.\n" +
        "Be on the same LAN as the robot. If you are running inside a sandbox, LAN broadcast may be blocked.",
    );
  }
  out(
    args,
    found,
    found
      .map((d) => `${d.name} — ${d.ip}\n  model ${d.sku}  blid ${d.blid}\n  fw ${d.softwareVer}\n  mac ${d.mac}`)
      .join("\n\n"),
  );
}

async function cmdPair(args) {
  if (!args.json) {
    console.log("Hold the robot's HOME/DOCK button down until it chirps (~2s), then release.");
    console.log("Polling for up to 3 minutes...");
  }
  const { config, file, attempts } = await pair({ ip: args.ip, onAttempt: () => {} });
  out(
    args,
    { ok: true, file, ip: config.ip, blid: config.blid, name: config.name, attempts },
    `Paired with ${config.name ?? config.ip} after ${attempts} attempts.\nCredentials written to ${file} (mode 0600).`,
  );
}

async function cmdStatus(args) {
  const snap = await withRobot((r) => r.snapshot(), { ip: args.ip });
  out(args, snap, formatStatus(snap));
}

async function cmdWhy(args) {
  const snap = await withRobot((r) => r.snapshot(), { ip: args.ip });
  out(args, snap.mission, snap.mission.summary);
}

async function cmdRaw(args) {
  const state = await withRobot((r) => r.state, { ip: args.ip });
  console.log(JSON.stringify(state, null, 2));
}

async function cmdSend(command, args) {
  const result = await withRobot(
    async (r) => {
      const before = r.snapshot();
      await r.send(command);
      return before;
    },
    { ip: args.ip },
  );
  out(
    args,
    { ok: true, command, stateBefore: result.mission },
    `Sent "${command}". State before: ${result.mission.summary}`,
  );
}

async function cmdWatch(args) {
  const robot = new RobotConnection({ ip: args.ip });
  await robot.connect({ timeoutMs: args.timeout ?? 20000 });
  console.error("watching — ctrl-c to stop (this holds the robot's only connection slot)");
  let last = "";
  const tick = () => {
    const snap = robot.snapshot();
    const line = args.json
      ? JSON.stringify({ at: new Date().toISOString(), ...snap })
      : `${new Date().toLocaleTimeString()}  ${snap.batteryPct ?? "?"}%  ${snap.mission.summary}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
  };
  tick();
  const interval = setInterval(tick, 1000);
  process.on("SIGINT", () => {
    clearInterval(interval);
    robot.disconnect();
    process.exit(0);
  });
}

async function cmdDashboard(args) {
  const port = args.port ?? 8080;
  const { url } = await serveDashboard({ port, overrides: { ip: args.ip } });
  console.log(`dashboard: ${url}`);
  // Keep the process alive; SIGINT handler in the server shuts it down.
  await new Promise(() => {});
}

const HANDLERS = {
  discover: cmdDiscover,
  pair: cmdPair,
  status: cmdStatus,
  why: cmdWhy,
  raw: cmdRaw,
  watch: cmdWatch,
  dashboard: cmdDashboard,
  start: (a) => cmdSend("start", a),
  clean: (a) => cmdSend("clean", a),
  pause: (a) => cmdSend("pause", a),
  stop: (a) => cmdSend("stop", a),
  resume: (a) => cmdSend("resume", a),
  dock: (a) => cmdSend("dock", a),
  find: (a) => cmdSend("find", a),
  evac: (a) => cmdSend("evac", a),
  train: (a) => cmdSend("train", a),
};

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || args.help) {
    console.log(USAGE);
    return 0;
  }
  const handler = HANDLERS[cmd];
  if (!handler) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 2;
  }
  try {
    await handler(args);
    return 0;
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
}
