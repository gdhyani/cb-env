import net from "node:net";
import { PORT_RANGE } from "../constants";
import { CbError } from "../shared/errors";

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** FR-AGT-003: stable ports per key, persisted; a taken port is reassigned (M0). */
export async function allocatePorts(
  keys: string[],
  current: Record<string, number>,
  range: { min: number; max: number } = PORT_RANGE,
): Promise<Record<string, number>> {
  const ports = { ...current };
  const reserved = new Set(Object.values(ports));
  for (const key of keys) {
    const existing = ports[key];
    if (existing !== undefined && (await isPortFree(existing))) continue;
    if (existing !== undefined) reserved.delete(existing);
    let chosen: number | undefined;
    for (let p = range.min; p <= range.max && chosen === undefined; p++) {
      if (!reserved.has(p) && (await isPortFree(p))) chosen = p;
    }
    if (chosen === undefined)
      throw new CbError(
        "NO_FREE_PORT",
        `cb: no free port in ${range.min}-${range.max}. Close other cb runs and retry.`,
      );
    ports[key] = chosen;
    reserved.add(chosen);
  }
  return ports;
}
