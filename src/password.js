import tls from "node:tls";
import { legacyTlsOptions } from "./tls.js";

const MAGIC = Buffer.from("f005efcc3b2900", "hex");
const PORT = 8883;

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
 * ~30s post-chirp window after HOME/DOCK is held down.
 * @param {string} ip
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<string>}
 */
export function getPassword(ip, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
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

    sock.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      // A 7-byte reply is the robot's "no" — the button window wasn't open.
      if (buf.length === 7) return finish(reject, new ButtonNotHeldError(ip));
      if (buf.length <= 7) return;
      const password = buf.subarray(13).toString("utf8").trim();
      if (!password) return finish(reject, new ButtonNotHeldError(ip));
      finish(resolve, password);
    });

    sock.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length <= 7) finish(reject, new ButtonNotHeldError(ip));
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
