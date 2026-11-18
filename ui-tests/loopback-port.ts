import { createServer, type Server } from "node:net";

/**
 * Ports above 1023 that browsers refuse to open: the "bad ports" of the Fetch
 * standard (https://fetch.spec.whatwg.org/#port-blocking). A system whose dynamic
 * port range starts low can hand one of them out as a free port.
 */
const refusedByBrowsers = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

/** A free loopback port that a browser will open. */
export async function loopbackPort(): Promise<number> {
  // A refused port stays taken until a usable one is found, so the system cannot offer it again.
  const refused: Server[] = [];
  try {
    for (;;) {
      const probe = createServer();
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
      const address = probe.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback port");
      if (refusedByBrowsers.has(address.port)) { refused.push(probe); continue; }
      await close(probe);
      return address.port;
    }
  } finally {
    await Promise.all(refused.map(close));
  }
}
