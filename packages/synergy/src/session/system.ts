import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"

import { Instance } from "../scope/instance"
import { SessionEndpoint } from "./endpoint"
import path from "path"
import os from "os"

import PROMPT_FALLBACK from "./prompt/fallback.txt"
import type { Provider } from "@/provider/provider"
import { Flag } from "@/flag/flag"

export namespace SystemPrompt {
  function formatLocalDate(date: Date): string {
    const offset = -date.getTimezoneOffset()
    const sign = offset >= 0 ? "+" : "-"
    const absOffset = Math.abs(offset)
    const hours = String(Math.floor(absOffset / 60)).padStart(2, "0")
    const minutes = String(absOffset % 60).padStart(2, "0")
    return `${date.toDateString()} (UTC${sign}${hours}:${minutes})`
  }

  function formatLocalDateTime(epochMs: number): string {
    const date = new Date(epochMs)
    const offset = -date.getTimezoneOffset()
    const sign = offset >= 0 ? "+" : "-"
    const absOffset = Math.abs(offset)
    const hours = String(Math.floor(absOffset / 60)).padStart(2, "0")
    const minutes = String(absOffset % 60).padStart(2, "0")
    return `${date.toLocaleString()} (UTC${sign}${hours}:${minutes})`
  }

  export function provider(_model: Provider.Model) {
    return [PROMPT_FALLBACK]
  }

  const endpointLabels: Record<string, string> = {
    feishu: "Feishu (Lark)",
    holos: "Holos",
  }

  export async function environment(options?: {
    endpointType?: string
    session?: {
      id: string
      title: string
      parentID?: string
      time: { created: number }
      endpoint?: SessionEndpoint.Info
      interaction?: { mode: string; source?: string }
    }
  }) {
    const scope = Instance.scope
    const endpointType = options?.endpointType
    const session = options?.session
    const envLines = [
      `  Working directory: ${Instance.directory}`,
      `  Is directory a git repo: ${scope.type === "project" && scope.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${formatLocalDate(new Date())}`,
    ]

    if (scope.type === "global") {
      if (!endpointType) {
        envLines.push(`  Scope: home`)
      }
    } else if (scope.type === "project") {
      envLines.push(`  Scope ID: ${scope.id}`)
      if (scope.name) envLines.push(`  Project name: ${scope.name}`)
    }

    if (session?.endpoint?.kind === "channel") {
      const ch = session.endpoint.channel
      const label = endpointLabels[ch.type] ?? ch.type
      const chatTypeLabel = ch.chatType === "group" ? "group chat" : ch.chatType === "dm" ? "direct message" : undefined
      envLines.push(`  Session source: ${label} channel${chatTypeLabel ? ` (${chatTypeLabel})` : ""}`)
      if (ch.chatId) envLines.push(`  Chat ID: ${ch.chatId}`)
      if (ch.senderName) envLines.push(`  User: ${ch.senderName}`)
      else if (ch.senderId) envLines.push(`  Sender ID: ${ch.senderId}`)
    } else if (session?.endpoint?.kind === "holos") {
      envLines.push(`  Session source: Holos contact`)
      envLines.push(`  Contact: ${session.endpoint.agentId}`)
    } else if (endpointType) {
      envLines.push(`  Session source: ${endpointLabels[endpointType] ?? endpointType} endpoint`)
    }

    if (session) {
      envLines.push(`  Session ID: ${session.id}`)
      if (session.title) envLines.push(`  Session title: ${session.title}`)
      envLines.push(`  Session created: ${formatLocalDateTime(session.time.created)}`)
      if (session.parentID) {
        envLines.push(`  Parent session: ${session.parentID}`)
      }
    }

    return [
      [
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        ...envLines,
        `</env>`,
        `<files>`,
        `  ${
          scope.type === "project" && scope.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 200,
              })
            : ""
        }`,
        `</files>`,
      ].join("\n"),
    ]
  }

  const LOCAL_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md", // deprecated
  ]
  const GLOBAL_RULE_FILES = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.SYNERGY_DISABLE_CLAUDE_CODE_PROMPT) {
    GLOBAL_RULE_FILES.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }

  if (Flag.SYNERGY_CONFIG_DIR) {
    GLOBAL_RULE_FILES.push(path.join(Flag.SYNERGY_CONFIG_DIR, "AGENTS.md"))
  }

  export async function custom() {
    const config = await Config.get()
    const paths = new Set<string>()

    for (const localRuleFile of LOCAL_RULE_FILES) {
      const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.directory)
      if (matches.length > 0) {
        matches.forEach((path) => paths.add(path))
        break
      }
    }

    for (const globalRuleFile of GLOBAL_RULE_FILES) {
      if (await Bun.file(globalRuleFile).exists()) {
        paths.add(globalRuleFile)
        break
      }
    }

    const urls: string[] = []
    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
          continue
        }
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        let matches: string[] = []
        if (path.isAbsolute(instruction)) {
          matches = await Array.fromAsync(
            new Bun.Glob(path.basename(instruction)).scan({
              cwd: path.dirname(instruction),
              absolute: true,
              onlyFiles: true,
            }),
          ).catch(() => [])
        } else {
          matches = await Filesystem.globUp(instruction, Instance.directory, Instance.directory).catch(() => [])
        }
        matches.forEach((path) => paths.add(path))
      }
    }

    const foundFiles = Array.from(paths).map((p) =>
      Bun.file(p)
        .text()
        .catch(() => "")
        .then((x) => "Instructions from: " + p + "\n" + x),
    )
    const foundUrls = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )
    return Promise.all([...foundFiles, ...foundUrls]).then((result) => result.filter(Boolean))
  }
}
