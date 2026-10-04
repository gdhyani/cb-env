import { z } from "zod";

/** Draft bootstrap contract (mirrors cb-backend bootstrap.service.ts). `{port}` is filled by the agent. */
export const BootstrapSchema = z.object({
  schema: z.literal(1),
  version: z.number().int(),
  orgId: z.string(),
  projectId: z.string(),
  projectSlug: z.string(),
  environment: z.string(),
  envId: z.string(),
  orgCaCert: z.string(),
  plain: z.record(z.string(), z.string()),
  listeners: z.array(
    z.object({ resourceId: z.string(), kind: z.string(), name: z.string(), env: z.record(z.string(), z.string()) }),
  ),
  redirects: z.array(z.object({ host: z.string(), port: z.number().int(), resourceId: z.string() })),
  visibleKeys: z.array(z.string()),
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

/** PRD §12.4 snapshot file read by the preload. */
export const SnapshotSchema = z.object({
  schema: z.literal(1),
  version: z.number().int(),
  status: z.enum(["active", "revoked"]),
  revokedReason: z.string().optional(),
  projectId: z.string(),
  environment: z.string(),
  env: z.record(z.string(), z.string()),
  redirects: z.record(z.string(), z.number().int()),
  fakeFiles: z.record(z.string(), z.string()),
  orgCaCert: z.string(),
  visibleKeys: z.array(z.string()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** PRD §12.6 `.cb/project.json` (committed). */
export const ProjectConfigSchema = z.object({
  server: z.string().url(),
  orgId: z.string(),
  projectId: z.string(),
  projectSlug: z.string().optional(),
  defaultEnvironment: z.string(),
  /** FR-WH-003: port your app listens on, for webhooks cb delivers (overridden by cb run --webhook-port). */
  webhookPort: z.number().int().min(1).max(65_535).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const CredentialsSchema = z.object({
  servers: z.record(
    z.string(),
    z.object({
      /** Present only with the file store; with the keychain the token never touches disk. */
      token: z.string().optional(),
      store: z.enum(["keychain", "file"]).default("file"),
      deviceId: z.string(),
      deviceName: z.string(),
      user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    }),
  ),
});
export type Credentials = z.infer<typeof CredentialsSchema>;
/**
 * In memory the secrets are always resolved, whichever store holds them. `token` is the refresh token
 * (or a legacy device token from before rotation); the access token is short-lived (FR-AUTH-004).
 */
export type ServerCredentials = Omit<Credentials["servers"][string], "token" | "store"> & {
  token: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
};

export const StateSchema = z.object({
  ports: z.record(z.string(), z.number().int()).default({}),
  environments: z.record(z.string(), z.string()).default({}),
});
export type State = z.infer<typeof StateSchema>;
