import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR =
  process.env.IROBOT_MCP_CONFIG_DIR ?? path.join(os.homedir(), ".config", "irobot-mcp");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

export function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return CONFIG_FILE;
}

/**
 * Credentials for a robot, from env or the on-disk config. Never invents values.
 * @param {{ip?: string, blid?: string}} overrides
 */
export function requireCredentials(overrides = {}) {
  const stored = readConfig();
  const ip = overrides.ip ?? process.env.ROOMBA_IP ?? stored?.ip;
  const blid = overrides.blid ?? process.env.ROOMBA_BLID ?? stored?.blid;
  const password = process.env.ROOMBA_PASSWORD ?? stored?.password;

  const missing = [
    !ip && "ip",
    !blid && "blid",
    !password && "password",
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `Missing robot credentials: ${missing.join(", ")}.\n` +
        `Run \`roomba pair\` (you must hold the robot's HOME/DOCK button until it chirps), ` +
        `or set ROOMBA_IP / ROOMBA_BLID / ROOMBA_PASSWORD.\n` +
        `Config file searched: ${CONFIG_FILE}`,
    );
  }
  return { ip, blid, password, name: stored?.name ?? null, sku: stored?.sku ?? null };
}
