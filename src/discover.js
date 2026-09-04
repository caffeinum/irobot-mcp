import dgram from "node:dgram";
import os from "node:os";

const PORT = 5678;
const PROBE = "irobotmcs";

function broadcastAddresses() {
  const addrs = ["255.255.255.255"];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const ip = i.address.split(".").map(Number);
      const mask = i.netmask.split(".").map(Number);
      addrs.push(ip.map((o, n) => o | (~mask[n] & 0xff)).join("."));
    }
  }
  return [...new Set(addrs)];
}

function parse(msg, rinfo) {
  const text = msg.toString("utf8");
  if (text === PROBE) return null; // echo of our own probe
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data.hostname && !data.robotname) return null;
  return {
    ip: rinfo.address,
    name: data.robotname ?? null,
    hostname: data.hostname ?? null,
    sku: data.sku ?? null,
    model: data.hostname?.split("-")[0] ?? null,
    blid: data.blid ?? data.robotid ?? data.hostname?.split("-")[1] ?? null,
    mac: data.mac ?? null,
    softwareVer: data.sw ?? data.ver ?? null,
    proto: data.proto ?? null,
    raw: data,
  };
}

/**
 * Broadcast the iRobot discovery probe and collect every device that answers.
 * @param {{timeoutMs?: number, target?: string}} opts
 * @returns {Promise<object[]>}
 */
export function discover({ timeoutMs = 5000, target } = {}) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

    sock.on("error", (err) => {
      sock.close();
      reject(new Error(`UDP discovery socket failed: ${err.message}`));
    });

    sock.on("message", (msg, rinfo) => {
      const dev = parse(msg, rinfo);
      if (dev) found.set(dev.ip, dev);
    });

    sock.bind(PORT, () => {
      sock.setBroadcast(true);
      const targets = target ? [target] : broadcastAddresses();
      const probe = Buffer.from(PROBE);
      const send = () => {
        for (const addr of targets) sock.send(probe, 0, probe.length, PORT, addr, () => {});
      };
      send();
      const retry = setInterval(send, 1000);
      setTimeout(() => {
        clearInterval(retry);
        sock.close();
        resolve([...found.values()]);
      }, timeoutMs);
    });
  });
}
