import z from "zod"

export type FilesystemAccessMode = "read" | "write" | "deny"
export type NetworkMode = "limited" | "full"

const FilesystemAccessModeSchema = z.enum(["read", "write", "deny"])

export const FilesystemPermissions = z
  .object({
    glob_scan_max_depth: z.number().optional(),
    read: z.string().array().optional(),
    write: z.string().array().optional(),
    deny: z.string().array().optional(),
  })
  .strict()

export const NetworkModeSchema = z.enum(["limited", "full"])

export const NetworkDomainPermissions = z.object({
  domains: z.string().array().optional(),
})

export const NetworkUnixSocketPermissions = z.object({
  sock_path: z.string(),
})

export const WorkspaceRoots = z.string().array()

export const NetworkConfig = z.object({
  enabled: z.boolean().optional(),
  mode: NetworkModeSchema.optional(),
  domains: z.string().array().optional(),
  unix_sockets: z.array(NetworkUnixSocketPermissions).optional(),
  allow_local_binding: z.boolean().optional(),
  proxy_url: z.string().optional(),
  enable_socks5: z.boolean().optional(),
  socks_url: z.string().optional(),
})

export const PermissionProfileToml = z.object({
  description: z.string().optional(),
  extends: z.string().optional(),
  workspace_roots: WorkspaceRoots.optional(),
  filesystem: FilesystemPermissions.optional(),
  network: NetworkConfig.optional(),
})

export type PermissionProfileToml = z.infer<typeof PermissionProfileToml>

export const TomlProfile = PermissionProfileToml
