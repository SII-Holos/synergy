import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"

const log = Log.create({ service: "agora.workspace" })

const Manifest = z.object({
  post_id: z.string(),
  answer_id: z.string(),
  branch: z.string(),
  repo: z.string().optional(),
  clone_url: z.string().optional(),
  type: z.enum(["contribution", "accept"]).optional(),
})

export type AgoraManifest = z.infer<typeof Manifest>

const MANIFEST_FILE = ".agora.json"

export namespace AgoraWorkspace {
  export function manifestPath(directory: string) {
    return path.join(directory, MANIFEST_FILE)
  }

  export async function readManifest(directory: string): Promise<AgoraManifest> {
    const filePath = manifestPath(directory)
    const exists = await Bun.file(filePath).exists()
    if (!exists) {
      throw new Error(
        `No ${MANIFEST_FILE} found in ${directory}. This directory is not an Agora workspace. Use agora_join to create one.`,
      )
    }
    const raw = await Bun.file(filePath).json()
    return Manifest.parse(raw)
  }

  export async function writeManifest(directory: string, manifest: AgoraManifest) {
    const filePath = manifestPath(directory)
    await Bun.write(filePath, JSON.stringify(manifest, null, 2) + "\n")
    log.info("wrote agora manifest", { directory, post_id: manifest.post_id, branch: manifest.branch })
  }

  export async function isWorkspace(directory: string): Promise<boolean> {
    return Bun.file(manifestPath(directory)).exists()
  }

  export interface GitResult {
    exitCode: number
    stdout: string
    stderr: string
  }

  export async function git(args: string[], options?: { cwd?: string; abort?: AbortSignal }): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
    })

    let aborted = false
    const onAbort = () => {
      aborted = true
      proc.kill()
    }
    if (options?.abort) {
      options.abort.addEventListener("abort", onAbort, { once: true })
    }

    try {
      const exitCode = await proc.exited
      const [stdout, stderr] = await Promise.all([
        proc.stdout ? new Response(proc.stdout).text().then((t) => t.trim()) : "",
        proc.stderr ? new Response(proc.stderr).text().then((t) => t.trim()) : "",
      ])
      if (aborted) throw new Error("Git operation aborted")
      return { exitCode, stdout, stderr }
    } finally {
      options?.abort?.removeEventListener("abort", onAbort)
    }
  }

  export async function gitOrFail(args: string[], options?: { cwd?: string; abort?: AbortSignal }): Promise<string> {
    const result = await git(args, options)
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`)
    }
    return result.stdout
  }

  export async function findConflictFiles(directory: string): Promise<string[]> {
    const result = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: directory })
    if (result.exitCode !== 0 || !result.stdout) return []
    return result.stdout.split("\n").filter(Boolean)
  }

  export async function hasStagedOrUntracked(directory: string): Promise<boolean> {
    const result = await git(["status", "--porcelain"], { cwd: directory })
    return result.exitCode === 0 && result.stdout.length > 0
  }

  export async function currentBranch(directory: string): Promise<string | undefined> {
    const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory })
    if (result.exitCode !== 0) return undefined
    const branch = result.stdout.trim()
    return branch === "HEAD" ? undefined : branch
  }

  export async function commitSummary(directory: string, count: number = 5): Promise<string[]> {
    const result = await git(["log", `--max-count=${count}`, "--format=%h %s"], {
      cwd: directory,
    })
    if (result.exitCode !== 0 || !result.stdout) return []
    return result.stdout.split("\n").filter(Boolean)
  }

  export async function isMergeInProgress(directory: string): Promise<boolean> {
    const mergeHead = path.join(directory, ".git", "MERGE_HEAD")
    return Bun.file(mergeHead).exists()
  }

  export async function pathExists(target: string): Promise<boolean> {
    return fs
      .stat(target)
      .then(() => true)
      .catch(() => false)
  }

  export async function streamText(stream?: ReadableStream<Uint8Array> | null): Promise<string> {
    if (!stream) return ""
    return new Response(stream).text().then((text) => text.trim())
  }
}
