import { Plugin } from "../plugin"
import { Format } from "../file/format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Bus } from "../bus"
import { Command } from "../skill/command"
import { Instance } from "@/scope/instance"
import { Scope } from "@/scope"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Scope.setInitialized(Instance.scope.id)
    }
  })
}

export async function ChannelBootstrap() {
  const { Config } = await import("@/config/config")
  const cfg = await Config.get()
  const channels = cfg.channel ?? {}
  if (Object.keys(channels).length > 0) {
    const { registerProviders } = await import("../channel/provider")
    const { Channel } = await import("../channel")
    const { ChannelOutbound } = await import("../channel/outbound")
    registerProviders()
    await Channel.init()
    ChannelOutbound.init()
  }
}

export async function HolosBootstrap() {
  const { HolosRuntime } = await import("@/holos/runtime")
  await HolosRuntime.init()
}
