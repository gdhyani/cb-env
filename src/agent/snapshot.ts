import type { Bootstrap, Snapshot } from "../shared/schemas";

export const listenerKey = (resourceId: string) => `l1:${resourceId}`;
export const redirectKey = (host: string, port: number) => `l2:${host.toLowerCase()}:${port}`;

/** PRD §12.4: plain + listener env (ports filled in) + redirect table. No real secrets except visible keys (S1). */
export function renderSnapshot(
  b: Bootstrap,
  portOf: (key: string) => number,
  filePaths: Record<string, string> = {},
): Snapshot {
  const env: Record<string, string> = { ...b.plain, ...filePaths };
  for (const l of b.listeners) {
    const port = String(portOf(listenerKey(l.resourceId)));
    for (const [k, v] of Object.entries(l.env)) env[k] = v.replaceAll("{port}", port);
  }
  const redirects: Record<string, number> = {};
  for (const r of b.redirects) redirects[`${r.host.toLowerCase()}:${r.port}`] = portOf(redirectKey(r.host, r.port));
  return {
    schema: 1,
    version: b.version,
    status: "active",
    projectId: b.projectId,
    environment: b.environment,
    env,
    redirects,
    fakeFiles: filePaths,
    orgCaCert: b.orgCaCert,
    visibleKeys: b.visibleKeys,
  };
}
