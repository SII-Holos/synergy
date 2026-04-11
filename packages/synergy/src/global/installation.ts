import { BusEvent } from "@/bus/bus-event"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"

declare global {
  const SYNERGY_VERSION: string
  const SYNERGY_CHANNEL: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })
  const NPM_REGISTRY = "https://registry.npmjs.org"

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export async function method() {
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula synergy`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      if (output.includes(check.name === "brew" ? "synergy" : "@ericsanchezok/synergy")) {
        return check.name
      }
    }

    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  async function getBrewFormula() {
    // Homebrew not supported for private repo
    return "synergy"
  }

  export async function upgrade(method: Method, target: string) {
    let cmd
    switch (method) {
      case "npm":
        cmd = $`npm install -g @ericsanchezok/synergy@${target} --registry=${NPM_REGISTRY}`
        break
      case "pnpm":
        cmd = $`pnpm install -g @ericsanchezok/synergy@${target} --registry=${NPM_REGISTRY}`
        break
      case "bun":
        cmd = $`bun install -g @ericsanchezok/synergy@${target} --registry=${NPM_REGISTRY}`
        break
      case "brew": {
        const formula = await getBrewFormula()
        cmd = $`brew install ${formula}`.env({
          HOMEBREW_NO_AUTO_UPDATE: "1",
          ...process.env,
        })
        break
      }
      default:
        throw new Error(`Unknown method: ${method}`)
    }
    const result = await cmd.quiet().throws(false)
    log.info("upgraded", {
      method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    if (result.exitCode !== 0)
      throw new UpgradeFailedError({
        stderr: result.stderr.toString("utf8"),
      })
    await $`${process.execPath} --version`.nothrow().quiet().text()
  }

  export const VERSION = typeof SYNERGY_VERSION === "string" ? SYNERGY_VERSION : "local"
  export const CHANNEL = typeof SYNERGY_CHANNEL === "string" ? SYNERGY_CHANNEL : "local"
  export const USER_AGENT = `synergy/${CHANNEL}/${VERSION}/${Flag.SYNERGY_CLIENT}`

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula === "synergy") {
        return fetch("https://formulae.brew.sh/api/formula/synergy.json")
          .then((res) => {
            if (!res.ok) throw new Error(res.statusText)
            return res.json()
          })
          .then((data: any) => data.versions.stable)
      }
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const channel = CHANNEL
      return fetch(`${NPM_REGISTRY}/@ericsanchezok/synergy/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return fetch("https://api.github.com/repos/SII-Holos/synergy/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
