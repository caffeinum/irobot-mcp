import { discover } from "./discover.js";
import { getPassword, ButtonNotHeldError } from "./password.js";
import { readConfig, writeConfig } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the robot for its local MQTT password until the human holds HOME/DOCK.
 * Retries are harmless — the robot only answers during its button window.
 * @param {{ip?: string, windowMs?: number, onAttempt?: (n: number) => void}} opts
 */
export async function pair({ ip, windowMs = 180000, onAttempt } = {}) {
  let device = null;
  if (!ip) {
    const found = await discover({ timeoutMs: 5000 });
    if (found.length === 0) {
      throw new Error(
        "No iRobot device answered the UDP discovery probe on port 5678.\n" +
          "Check you are on the same LAN as the robot, and that the robot is awake.",
      );
    }
    device = found[0];
    ip = device.ip;
  }

  const deadline = Date.now() + windowMs;
  let attempt = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    attempt += 1;
    onAttempt?.(attempt);
    try {
      const password = await getPassword(ip, { timeoutMs: 8000 });
      const config = {
        ...(readConfig() ?? {}),
        ip,
        blid: device?.blid ?? readConfig()?.blid ?? null,
        name: device?.name ?? readConfig()?.name ?? null,
        sku: device?.sku ?? readConfig()?.sku ?? null,
        softwareVer: device?.softwareVer ?? readConfig()?.softwareVer ?? null,
        password,
        pairedAt: new Date().toISOString(),
      };
      if (!config.blid) {
        const rediscovered = await discover({ timeoutMs: 4000, target: ip });
        config.blid = rediscovered[0]?.blid ?? null;
      }
      if (!config.blid) {
        throw new Error(
          `Got a password from ${ip} but could not determine its blid. ` +
            `Re-run \`roomba discover\` while the robot is awake.`,
        );
      }
      const file = writeConfig(config);
      return { config, file, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (!(err instanceof ButtonNotHeldError)) {
        // Transient LAN errors (EHOSTUNREACH from a sleeping wifi radio) are
        // normal here; keep polling and only surface them if we run out of time.
        if (!/EHOSTUNREACH|ETIMEDOUT|ECONNRESET|Timed out/.test(err.message)) throw err;
      }
      await sleep(2000);
    }
  }

  throw new Error(
    `Gave up after ${attempt} attempts over ${Math.round(windowMs / 1000)}s.\n` +
      `Last: ${lastError?.message ?? "unknown"}\n` +
      `The robot only reveals its password for a few seconds after you hold HOME/DOCK until it chirps.`,
  );
}
