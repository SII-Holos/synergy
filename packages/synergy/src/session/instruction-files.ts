import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { Filesystem } from "../util/filesystem"

export namespace InstructionFiles {
  export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024

  const LOCAL_OVERRIDE_FILE = "AGENTS.override.md"
  const LOCAL_PRIMARY_FILE = "AGENTS.md"
  const LOCAL_COMPAT_FILES = ["CLAUDE.md", "CONTEXT.md"]

  function dedupe(names: string[]) {
    const result: string[] = []
    for (const name of names) {
      const trimmed = name.trim()
      if (!trimmed || result.includes(trimmed)) continue
      result.push(trimmed)
    }
    return result
  }

  function localCandidateFilenames(config: Config.Info) {
    return dedupe([
      LOCAL_OVERRIDE_FILE,
      LOCAL_PRIMARY_FILE,
      ...(config.project_doc_fallback_filenames ?? []),
      ...LOCAL_COMPAT_FILES,
    ])
  }

  function containsPath(parent: string, child: string) {
    const relative = path.relative(parent, child)
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  }

  function searchDirsWithinScope() {
    const cwd = path.resolve(ScopeContext.current.directory)
    const scope = ScopeContext.current.scope
    if (scope.type !== "project") return [cwd]

    const root = path.resolve(scope.directory)
    if (!containsPath(root, cwd)) return [cwd]

    const dirs: string[] = []
    let current = cwd
    while (true) {
      dirs.push(current)
      if (current === root) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return dirs.reverse()
  }

  async function isFile(filepath: string) {
    return fs
      .stat(filepath)
      .then((stat) => stat.isFile())
      .catch(() => false)
  }

  async function readFilePart(filepath: string, maxBytes?: number) {
    if (maxBytes !== undefined && maxBytes <= 0) return undefined

    const data = await fs.readFile(filepath).catch(() => undefined)
    if (!data) return undefined

    const limited = maxBytes !== undefined && data.byteLength > maxBytes ? data.subarray(0, maxBytes) : data
    const text = new TextDecoder().decode(limited)
    if (!text.trim()) return undefined
    return `Instructions from: ${filepath}\n${text}`
  }

  async function discoverProjectPaths(config: Config.Info) {
    const result: string[] = []
    const names = localCandidateFilenames(config)

    for (const dir of searchDirsWithinScope()) {
      for (const name of names) {
        const candidate = path.join(dir, name)
        if (!(await isFile(candidate))) continue
        result.push(candidate)
        break
      }
    }
    return result
  }

  function globalCandidates() {
    const result = [
      path.join(Global.Path.config, LOCAL_OVERRIDE_FILE),
      path.join(Global.Path.config, LOCAL_PRIMARY_FILE),
    ]
    if (!Flag.SYNERGY_DISABLE_CLAUDE_CODE_PROMPT) {
      result.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
    }
    if (Flag.SYNERGY_CONFIG_DIR) {
      result.push(path.join(Flag.SYNERGY_CONFIG_DIR, LOCAL_OVERRIDE_FILE))
      result.push(path.join(Flag.SYNERGY_CONFIG_DIR, LOCAL_PRIMARY_FILE))
    }
    return result
  }

  async function discoverGlobalPath() {
    for (const candidate of globalCandidates()) {
      if (await isFile(candidate)) return candidate
    }
    return undefined
  }

  async function loadExplicitInstructions(instructions: string[] | undefined, excludedPaths: Set<string>) {
    if (!instructions) return []

    const paths = new Set<string>()
    const urls: string[] = []
    for (let instruction of instructions) {
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
        matches = await Filesystem.globUp(
          instruction,
          ScopeContext.current.directory,
          ScopeContext.current.directory,
        ).catch(() => [])
      }
      matches.forEach((match) => {
        if (!excludedPaths.has(match)) paths.add(match)
      })
    }

    const foundFiles = Array.from(paths).map((filepath) => readFilePart(filepath))
    const foundUrls = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((text) => (text.trim() ? `Instructions from: ${url}\n${text}` : undefined)),
    )
    return Promise.all([...foundFiles, ...foundUrls]).then((result) => result.filter((x): x is string => !!x))
  }

  export async function load() {
    const config = await Config.current()
    const maxBytes = config.project_doc_max_bytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES
    const projectPaths = maxBytes <= 0 ? [] : await discoverProjectPaths(config)
    const globalPath = maxBytes <= 0 ? undefined : await discoverGlobalPath()
    const automaticPaths = globalPath ? [...projectPaths, globalPath] : projectPaths

    const automaticParts = await Promise.all(automaticPaths.map((filepath) => readFilePart(filepath, maxBytes)))
    const explicitParts = await loadExplicitInstructions(config.instructions, new Set(automaticPaths))
    return [...automaticParts.filter((part): part is string => !!part), ...explicitParts]
  }
}
