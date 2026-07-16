import path from "path"
import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "clarus.config" })

const DEFAULT_WORKSPACE_ROOT = path.join(Global.Path.data, "clarus-workspaces")

let resolvedConfig: { workspaceRoot: string; enabled: boolean } | null = null

export namespace ClarusConfigReader {
  export async function resolve(): Promise<{ workspaceRoot: string; enabled: boolean }> {
    if (resolvedConfig) return resolvedConfig

    const { Config } = await import("@/config/config")
    const cfg = await Config.current()
    const clarus = cfg.clarus

    const workspaceRoot = clarus?.workspaceRoot ? path.resolve(clarus.workspaceRoot) : DEFAULT_WORKSPACE_ROOT
    const enabled = clarus?.enabled ?? true

    resolvedConfig = { workspaceRoot, enabled }
    log.info("clarus config resolved", { workspaceRoot, enabled })
    return resolvedConfig
  }

  export function resolveSync(): { workspaceRoot: string; enabled: boolean } {
    if (resolvedConfig) return resolvedConfig

    const cfg = { workspaceRoot: DEFAULT_WORKSPACE_ROOT, enabled: true }
    resolvedConfig = cfg
    log.info("clarus config resolved (sync fallback)", cfg)
    return cfg
  }

  export function invalidate(): void {
    resolvedConfig = null
  }
}

/** Agent identity credential read dynamically from Holos runtime. */
export interface ClarusCredential {
  agentId: string
  agentSecret: string
}

/**
 * Structural supplier that reads active credentials on every request.
 * apiUrl is provided separately to the REST client constructor.
 */
export type ClarusCredentialSupplier = () => Promise<ClarusCredential | undefined>
