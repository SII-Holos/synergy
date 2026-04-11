import { resolveNetworkArgv } from "../cli/network"
import { Config } from "../config/config"
import { Server } from "../server/server"
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

  export async function resolveNetwork(input?: { argv?: string[]; config?: GlobalConfig }): Promise<Network> {
    const config = input?.config ?? (await Config.global())
    const network = await resolveNetworkArgv({
      argv: input?.argv,
      config,
      defaults: {
        hostname: "127.0.0.1",
        port: Server.DEFAULT_PORT,
        mdns: false,
        cors: [],
      },
    })

    const connectHostname = normalizeConnectHostname(network.hostname)

    return {
      ...network,
      connectHostname,
      url: buildUrl(connectHostname, network.port),
    }
  }

  export async function resolve(input?: { argv?: string[]; config?: GlobalConfig }): Promise<ManagedService> {
    const config = input?.config ?? (await Config.global())
    const network = await resolveNetwork({ argv: input?.argv, config })
    const command = DaemonCommand.resolve({ hostname: network.hostname, port: network.port })

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

  export function normalizeConnectHostname(hostname: string) {
    if (hostname === "0.0.0.0") return "127.0.0.1"
    if (hostname === "::") return "::1"
    return hostname
  }

  function buildUrl(hostname: string, port: number) {
    const url = new URL("http://127.0.0.1")
    url.hostname = hostname
    url.port = String(port)
    return url.toString().replace(/\/$/, "")
  }
}
