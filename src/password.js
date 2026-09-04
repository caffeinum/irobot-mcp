import tls from "node:tls";
import { legacyTlsOptions } from "./tls.js";

const MAGIC = Buffer.from("f005efcc3b2900", "hex");
const PORT = 8883;
// The robot frames its reply as <13-byte header><password>. On some firmware a
// 2-byte length packet arrives first, which shifts the header to 9 bytes.
const DEFAULT_SLICE = 13;
const SHORT_SLICE = 9;
// After the first byte, wait this long for trailing TCP segments before deciding.
const GRACE_MS = 800;

export class ButtonNotHeldError extends Error {
  constructor(ip) {
    super(
      `Robot at ${ip} refused to hand over its password.\n` +
        `Hold the HOME/DOCK button until the robot chirps (~2s), then re-run within a few seconds.`,
    );
    this.name = "ButtonNotHeldError";
  }
}

/**
 * Extract the local MQTT password. Only works while the robot is in its
 * post-chirp window after HOME/DOCK is held down. Accumulates every TCP segment
 * and only decides once the robot goes quiet, so a password split across
 * packets is never truncated.
 * @param {string} ip
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<string>}
 */
export function getPassword(ip, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let sliceFrom = DEFAULT_SLICE;
    let settled = false;
    let graceTimer = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      sock.destroy();
      fn(arg);
    };

    const decide = () => {
      const buf = Buffer.concat(chunks);
      if (buf.length <= 7) return finish(reject, new ButtonNotHeldError(ip));
      // Strip a single trailing null byte the framing sometimes leaves.
      let end = buf.length;
      if (buf[end - 1] === 0) end -= 1;
      const password = buf.subarray(sliceFrom, end).toString("utf8");
      if (!password) return finish(reject, new ButtonNotHeldError(ip));
      finish(resolve, password);
    };

    const sock = tls.connect(PORT, ip, legacyTlsOptions(), () => {
      sock.write(MAGIC);
    });

    const timer = setTimeout(
      () => finish(reject, new Error(`Timed out after ${timeoutMs}ms waiting for ${ip}:${PORT}`)),
      timeoutMs,
    );

    sock.on("data", (chunk) => {
      // A lone 2-byte length prefix shifts where the password starts.
      if (chunks.length === 0 && chunk.length === 2) {
        sliceFrom = SHORT_SLICE;
      }
      chunks.push(chunk);
      clearTimeout(graceTimer);
      graceTimer = setTimeout(decide, GRACE_MS);
    });

    sock.on("end", decide);

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
