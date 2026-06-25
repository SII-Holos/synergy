import fs from "fs/promises"
import path from "path"
import { readableStreamToText } from "bun"
import { ConfigDomain } from "./domain"
import { Global } from "../global"

export namespace ConfigDomainOpen {
  export type OpenResult = {
    success: true
    path: string
  }

  export class UnsupportedPlatformError extends Error {
    constructor(public platform: string) {
      super(`Opening config files is not supported on ${platform}`)
      this.name = "ConfigDomainOpenUnsupportedPlatformError"
    }
  }

  export class OpenerMissingError extends Error {
    constructor(public opener: string) {
      super(`Required opener "${opener}" was not found`)
      this.name = "ConfigDomainOpenOpenerMissingError"
    }
  }

  export class OpenFailedError extends Error {
    constructor(
      public filepath: string,
      public code: number,
      public stderr?: string,
    ) {
      super(`Failed to open ${filepath}${stderr ? `: ${stderr}` : ""}`)
      this.name = "ConfigDomainOpenFailedError"
    }
  }

  export type CommandResolver = (name: string) => string | null | undefined

  export function commandForPlatform(
    filepath: string,
    platform = process.platform,
    resolve: CommandResolver = Bun.which,
  ): string[] {
    if (platform === "darwin") {
      const opener = resolve("open")
      if (!opener) throw new OpenerMissingError("open")
      return [opener, filepath]
    }

    if (platform === "linux") {
      const opener = resolve("xdg-open")
      if (!opener) throw new OpenerMissingError("xdg-open")
      return [opener, filepath]
    }

    if (platform === "win32") {
      return [process.env.COMSPEC || "cmd.exe", "/c", "start", "", filepath]
    }

    throw new UnsupportedPlatformError(platform)
  }

  export async function materialize(id: ConfigDomain.Id, root = Global.Path.config): Promise<string> {
    const filepath = ConfigDomain.filepath(id, root)
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    if (!(await Bun.file(filepath).exists())) {
      await Bun.write(filepath, "{}\n")
    }
    return filepath
  }

  export async function open(id: ConfigDomain.Id): Promise<OpenResult> {
    const filepath = await materialize(id)
    const cmd = commandForPlatform(filepath)
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = proc.stderr ? (await readableStreamToText(proc.stderr)).trim() : undefined
      throw new OpenFailedError(filepath, code, stderr)
    }
    return { success: true, path: filepath }
  }
}
