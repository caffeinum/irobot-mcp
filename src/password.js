import tls from "node:tls";
import { legacyTlsOptions } from "./tls.js";

const MAGIC = Buffer.from("f005efcc3b2900", "hex");
const PORT = 8883;
// The reply is framed as: 0xf0 <length> <5-byte echo of efcc3b2900> <password>.
// The password begins right after that echo. dorita980 hardcodes 13, but this
// daredevil firmware uses a 7-byte header — so we locate the echo instead of
// assuming a fixed offset.
const ECHO = Buffer.from("efcc3b2900", "hex");
const FALLBACK_SLICE = 13;

export class ButtonNotHeldError extends Error {
  constructor(ip) {
    super(
      `Robot at ${ip} refused to hand over its password.\n` +
        `Hold the HOME/DOCK button until the robot chirps (~2s), then re-run within a few seconds.`,
    );
    this.name = "ButtonNotHeldError";
  }
}

function looksLikeState(buf) {
  // The local broker also pushes state JSON on this socket. A password never
  // contains a JSON object; a state dump always does.
  const s = buf.toString("utf8");
  return s.includes('"state"') || s.includes('"reported"') || s.includes('wifistat') || /[{}]/.test(s.slice(DEFAULT_SLICE));
}

/**
 * Extract the local MQTT password. Reads ONLY the robot's first reply packet —
 * the password arrives as a single framed message, and later packets on this
 * socket are unrelated state pushes that must not be concatenated onto it.
 * @param {string} ip
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<string>}
 */
export function getPassword(ip, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(arg);
    };

    const sock = tls.connect(PORT, ip, legacyTlsOptions(), () => {
      sock.write(MAGIC);
    });

    const timer = setTimeout(
      () => finish(reject, new Error(`Timed out after ${timeoutMs}ms waiting for ${ip}:${PORT}`)),
      timeoutMs,
    );

    // One event = one framed reply. Do not wait for or merge later packets.
    sock.once("data", (data) => {
      if (process.env.IROBOT_DEBUG) {
        console.error(`[password] first packet: ${data.length} bytes, hex head ${data.subarray(0, 16).toString("hex")}`);
      }
      if (data.length <= 7) return finish(reject, new ButtonNotHeldError(ip));
      // Password starts right after the echoed magic; fall back to a fixed
      // offset if the echo isn't found where expected.
      const echoAt = data.indexOf(ECHO);
      const sliceFrom = echoAt >= 0 ? echoAt + ECHO.length : FALLBACK_SLICE;
      if (looksLikeState(data)) {
        return finish(
          reject,
          new Error(
            `Robot at ${ip} streamed state instead of a password. It answered the magic packet ` +
              `outside its button window. Hold HOME/DOCK until it chirps, release, then retry immediately.`,
          ),
        );
      }
      let end = data.length;
      if (data[end - 1] === 0) end -= 1; // strip a single trailing null
      const password = data.subarray(sliceFrom, end).toString("utf8");
      if (!password) return finish(reject, new ButtonNotHeldError(ip));
      finish(resolve, password);
    });

    sock.on("error", (err) =>
      finish(
        reject,
        new Error(
          `TLS connection to ${ip}:${PORT} failed: ${err.message}\n` +
            `If this is a cipher/protocol error, override with ROBOT_CIPHERS=<openssl cipher string>.`,
        ),
      ),
    );
  });
}
