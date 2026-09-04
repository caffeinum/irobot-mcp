import dorita980 from "dorita980";
import crypto from "node:crypto";
import { requireCredentials } from "./config.js";
import { ROBOT_CIPHERS } from "./tls.js";
import { explain } from "./errors.js";

const { Local } = dorita980;

/** Commands that make the robot physically move. */
export const MOTION_COMMANDS = new Set(["start", "clean", "cleanRoom", "resume", "dock", "train", "evac"]);

/**
 * The mission cycle each command should drive the robot into, used to confirm a
 * command actually landed before we drop the (single) connection. Commands not
 * listed here (find, pause) don't change cycle and fall back to a fixed settle.
 */
const EXPECTED_CYCLE = {
  start: ["clean", "quick", "spot"],
  clean: ["clean", "quick", "spot"],
  cleanRoom: ["clean", "quick", "spot"],
  stop: ["none"],
  dock: ["dock"],
  resume: ["clean", "quick", "spot"],
  evac: ["evac", "dock"],
  train: ["train"],
};

/** Every mission-level command the hardware actually supports. There is no drive/turn. */
export const COMMANDS = [
  "start",
  "clean",
  "cleanRoom",
  "pause",
  "stop",
  "resume",
  "dock",
  "find",
  "evac",
  "train",
];

export class RobotConnection {
  #client = null;
  #state = {};
  #creds;

  constructor(overrides = {}) {
    this.#creds = requireCredentials(overrides);
  }

  get credentials() {
    return { ...this.#creds, password: "<redacted>" };
  }

  get state() {
    return this.#state;
  }

  /**
   * Open the single MQTT connection and wait until the robot pushes state.
   * The broker allows exactly one client — connecting here evicts the phone app.
   */
  connect({ timeoutMs = 20000 } = {}) {
    if (this.#client) return Promise.resolve(this.#client);
    const { ip, blid, password } = this.#creds;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          this.#client?.end(true);
        } catch {}
        this.#client = null;
        reject(new Error(message));
      };

      const client = Local(blid, password, ip, {
        ciphers: ROBOT_CIPHERS,
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
        onError: (err) => {
          const hint = /Not authorized|Connection refused/i.test(err.message)
            ? "\nThe robot rejected these credentials. Re-run `roomba pair` to extract a fresh password."
            : /cipher|protocol|SSL|handshake/i.test(err.message)
              ? `\nTLS negotiation failed. The robot only speaks legacy suites; current ROBOT_CIPHERS="${ROBOT_CIPHERS}". Override with the ROBOT_CIPHERS env var.`
              : /EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED/i.test(err.message)
                ? `\nCould not reach ${ip}:8883. The robot may be asleep, off its dock's wifi, or another client (the iRobot app) may hold the broker's single connection slot.`
                : "";
          fail(`MQTT connection to ${ip} failed: ${err.message}${hint}`);
        },
      });
      this.#client = client;

      client.on("state", (state) => {
        this.#state = state;
        if (settled) return;
        // Wait for real telemetry, not just the connack.
        if (state.cleanMissionStatus || state.batPct != null) {
          settled = true;
          clearTimeout(timer);
          resolve(client);
        }
      });

      const timer = setTimeout(
        () =>
          fail(
            `Connected to ${ip} but the robot sent no state within ${timeoutMs}ms. ` +
              `It may be asleep — press any button on the robot to wake it and retry.`,
          ),
        timeoutMs,
      );
    });
  }

  async send(command, args) {
    if (!this.#client) throw new Error("Not connected. Call connect() first.");
    if (!COMMANDS.includes(command)) {
      throw new Error(
        `Unknown command "${command}". This hardware supports only: ${COMMANDS.join(", ")}. ` +
          `There is no drive/turn/motor control on wifi Roombas.`,
      );
    }
    if (command === "cleanRoom" && !args) {
      throw new Error("cleanRoom requires a region argument ({pmap_id, regions, user_pmapv_id}).");
    }
    // The publish is MQTT QoS 0: its callback fires when the packet is written
    // to the socket, NOT when the broker has processed it. Tearing the TLS
    // connection down immediately (as a connect->send->disconnect CLI does)
    // races the broker and silently drops the command. So we hold the
    // connection open until the robot's state actually reflects the command,
    // falling back to a fixed settle for commands that don't change cycle
    // (find/pause). This is what makes one-shot CLI commands reliable.
    await (command === "cleanRoom" ? this.#client.cleanRoom(args) : this.#client[command]());
    await this.#awaitEffect(command);
  }

  /** Wait until state reflects a command, or a short settle elapses. */
  #awaitEffect(command, { timeoutMs = 4000, settleMs = 1500 } = {}) {
    const expected = EXPECTED_CYCLE[command];
    if (!expected) return new Promise((r) => setTimeout(r, settleMs));
    return new Promise((resolve) => {
      const done = () => {
        this.#client.removeListener("state", check);
        clearTimeout(timer);
        resolve();
      };
      const check = (state) => {
        const cycle = state?.cleanMissionStatus?.cycle;
        if (expected.includes(cycle)) done();
      };
      // Already satisfied?
      if (expected.includes(this.#state?.cleanMissionStatus?.cycle)) return resolve();
      this.#client.on("state", check);
      // Fall back to a settle so we never hang if the robot is slow to reflect it.
      const timer = setTimeout(done, timeoutMs);
    });
  }

  /** Full raw state plus a decoded, plain-language reading of it. */
  snapshot() {
    const s = this.#state;
    return {
      name: s.name ?? this.#creds.name ?? null,
      sku: s.sku ?? this.#creds.sku ?? null,
      softwareVer: s.softwareVer ?? null,
      batteryPct: s.batPct ?? null,
      bin: s.bin ?? null,
      dockKnown: s.dock?.known ?? null,
      signal: s.signal ?? null,
      lastCommand: s.lastCommand ?? null,
      // Newer i-series firmware often stops reporting pose locally; absent is normal.
      pose: s.pose ?? null,
      lifetime: s.bbrun
        ? { scrubs: s.bbrun.nScrubs, stuck: s.bbrun.nStuck, pickups: s.bbrun.nPicks, missions: s.bbmssn?.nMssn }
        : null,
      mission: explain(s),
    };
  }

  disconnect() {
    // Graceful end() flushes any buffered packet before closing; force-close
    // would discard it. #awaitEffect has already confirmed delivery by here.
    try {
      this.#client?.end(false);
    } catch {}
    this.#client = null;
  }
}

/** Connect, run one operation, always release the broker's single slot. */
export async function withRobot(fn, overrides = {}) {
  const robot = new RobotConnection(overrides);
  try {
    await robot.connect();
    return await fn(robot);
  } finally {
    robot.disconnect();
  }
}
