import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { Filesystem } from "../util/filesystem"
import { isPathContained } from "../util/path-contain"

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

  function searchDirsWithinScope() {
    const cwd = path.resolve(ScopeContext.current.directory)
    const scope = ScopeContext.current.scope
    if (scope.type !== "project") return [cwd]

    const root = path.resolve(scope.directory)
    if (!isPathContained(root, cwd)) return [cwd]

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

  interface CachedFile {
    fingerprint: string
    part: string | undefined
  }

  interface CachedLoad {
    files: Map<string, CachedFile>
  }

  // One memo per loaded configuration: Config.state() is keyed by scope and
  // returns the same value until a reload replaces it, so that value is the
  // configuration revision. The turn path assembles the system prompt on every
  // model round, so later rounds reuse the parts read for the first. The
  // workspace directory separates the workspaces of one scope, and every part is
  // revalidated against its stat fingerprint before reuse: instruction files are
  // workspace content, so editing one (which does not reload the configuration)
  // must still be observed instead of serving stale text for the whole turn.
  // Remote instruction URLs stay outside the memo because they expose no
  // equivalent revalidation.
  const loads = new WeakMap<object, Map<string, CachedLoad>>()
  let fileReads = 0
  let fileReuses = 0

  export function stats() {
    return { fileReads, fileReuses }
  }

  export function resetStatsForTest() {
    fileReads = 0
    fileReuses = 0
  }

  function loadCache(revision: object): CachedLoad {
    let byWorkspace = loads.get(revision)
    if (!byWorkspace) {
      byWorkspace = new Map()
      loads.set(revision, byWorkspace)
    }
    const key = ScopeContext.current.directory
    let entry = byWorkspace.get(key)
    if (!entry) {
      entry = { files: new Map() }
      byWorkspace.set(key, entry)
    }
    return entry
  }

  // Identity of a file's bytes for reuse decisions: inode, size, and the
  // sub-millisecond mtime/ctime pair. A replaced file changes inode; an
  // equal-size rewrite advances the timestamps.
  async function fileFingerprint(filepath: string) {
    const stat = await fs.stat(filepath).catch(() => undefined)
    if (!stat?.isFile()) return undefined
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }

  async function readInstructionFilePart(filepath: string, maxBytes?: number) {
    if (maxBytes !== undefined && maxBytes <= 0) return undefined

    const data = await fs.readFile(filepath).catch(() => undefined)
    if (!data) return undefined

    const limited = maxBytes !== undefined && data.byteLength > maxBytes ? data.subarray(0, maxBytes) : data
    const text = new TextDecoder().decode(limited)
    if (!text.trim()) return undefined
    return `Instructions from: ${filepath}\n${text}`
  }

  async function cachedInstructionFilePart(cache: CachedLoad, filepath: string, maxBytes?: number) {
    if (maxBytes !== undefined && maxBytes <= 0) return undefined

    const fingerprint = await fileFingerprint(filepath)
    const key = `${maxBytes ?? "all"}\0${filepath}`
    const cached = fingerprint === undefined ? undefined : cache.files.get(key)
    if (cached && cached.fingerprint === fingerprint) {
      fileReuses++
      return cached.part
    }

    fileReads++
    const part = await readInstructionFilePart(filepath, maxBytes)
    if (fingerprint !== undefined) cache.files.set(key, { fingerprint, part })
    return part
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

  async function loadExplicitInstructions(
    instructions: string[] | undefined,
    excludedPaths: Set<string>,
    cache: CachedLoad,
  ) {
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

    const foundFiles = Array.from(paths).map((filepath) => cachedInstructionFilePart(cache, filepath))
    const foundUrls = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((text) => (text.trim() ? `Instructions from: ${url}\n${text}` : undefined)),
    )
    return Promise.all([...foundFiles, ...foundUrls]).then((result) => result.filter((x): x is string => !!x))
  }

  const PART_HEADER_PREFIX = "Instructions from: "

  function partBody(part: string): string {
    if (!part.startsWith(PART_HEADER_PREFIX)) return part
    const newline = part.indexOf("\n")
    return newline === -1 ? "" : part.slice(newline + 1)
  }

  function dedupeParts(parts: string[]): string[] {
    const firstIndex = new Map<string, number>()
    const result: string[] = []
    for (const part of parts) {
      const body = partBody(part)
      const existing = firstIndex.get(body)
      // Keep the first position for stable ordering but the nearest source
      // header: relative links and directory-relative wording resolve
      // against the active/nearest copy, not the earliest one.
      if (existing === undefined) {
        firstIndex.set(body, result.length)
        result.push(part)
        continue
      }
      result[existing] = part
    }
    return result
  }

  export async function load() {
    const [revision, config] = await Promise.all([Config.state(), Config.current()])
    const cache = loadCache(revision)
    const maxBytes = config.project_doc_max_bytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES
    const projectPaths = maxBytes <= 0 ? [] : await discoverProjectPaths(config)
    const globalPath = maxBytes <= 0 ? undefined : await discoverGlobalPath()
    const automaticPaths = globalPath ? [globalPath, ...projectPaths] : projectPaths

    const automaticParts = await Promise.all(
      automaticPaths.map((filepath) => cachedInstructionFilePart(cache, filepath, maxBytes)),
    )
    const explicitParts = await loadExplicitInstructions(config.instructions, new Set(automaticPaths), cache)
    return dedupeParts([...automaticParts.filter((part): part is string => !!part), ...explicitParts])
  }
}
