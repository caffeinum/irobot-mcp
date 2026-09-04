import crypto from "node:crypto";

/**
 * Roomba brokers speak legacy TLS: RSA key exchange, CBC suites, and legacy
 * (unsafe) renegotiation. OpenSSL 3 rejects all of that by default, so every
 * connection has to opt back down. `@SECLEVEL=0` is what re-enables the suites;
 * without it the handshake dies with "no cipher overlap" / "unsupported protocol".
 */
export const ROBOT_CIPHERS =
  process.env.ROBOT_CIPHERS ?? "AES256-SHA:AES128-SHA256:AES128-SHA:@SECLEVEL=0";

export function legacyTlsOptions(extra = {}) {
  return {
    rejectUnauthorized: false, // robot presents a self-signed cert keyed to its blid
    ciphers: ROBOT_CIPHERS,
    minVersion: "TLSv1",
    maxVersion: "TLSv1.2",
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    ...extra,
  };
}
