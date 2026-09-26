import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import {
  resolveServerNetwork,
  normalizeConnectHostname as normalizeNetworkHostname,
  loadNetworkConfig,
} from "@ericsanchezok/synergy-local-runtime/cli/network"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import type { DaemonService } from "./service"
import { DaemonCommand } from "./command"

export namespace DaemonSpec {
  type GlobalConfig = Awaited<ReturnType<typeof Config.global>>

  export interface Network {
    hostname: string
    port: number
    url: string
    connectHostname: string
    mdns: boolean
    cors: string[]
  }

  export interface ManagedService extends DaemonService.InstallSpec {
    url: string
    connectHostname: string
    mdns: boolean
    cors: string[]
  }

  export const resolveNetwork = resolveServerNetwork

  export async function resolve(input?: { argv?: string[]; config?: GlobalConfig }): Promise<ManagedService> {
    if (!input?.config) Config.global.reset()
    const config = input?.config ?? (await loadNetworkConfig())
    const network = await resolveNetwork({ argv: input?.argv, config })
    const command = DaemonCommand.resolve({
      hostname: network.hostname,
      port: network.port,
      env: RuntimeContext.current().host.env,
    })

    return {
      label: DaemonCommand.serviceLabel(),
      hostname: network.hostname,
      port: network.port,
      url: network.url,
      connectHostname: network.connectHostname,
      mdns: network.mdns,
      cors: network.cors,
      command: command.cmd,
      cwd: command.cwd,
      env: command.env,
      logFile: DaemonCommand.logPath(),
    }
  }

  export const normalizeConnectHostname = normalizeNetworkHostname
}
