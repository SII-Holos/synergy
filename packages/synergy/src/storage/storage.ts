import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export namespace Storage {
  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  function resolveDir() {
    return Global.Path.data
  }

  export async function remove(key: string[]) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    await fs.unlink(target).catch(() => {})
    await pruneEmptyParents(path.dirname(target), dir)
  }

  export async function read<T>(key: string[]) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Bun.file(target).json()
      return result as T
    })
  }

  export async function readMany<T>(keys: string[][]): Promise<(T | undefined)[]> {
    const dir = resolveDir()
    return Promise.all(
      keys.map(async (key) => {
        const target = path.join(dir, ...key) + ".json"
        try {
          using _ = await Lock.read(target)
          return (await Bun.file(target).json()) as T
        } catch {
          return undefined
        }
      }),
    )
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Bun.file(target).json()
      fn(content)
      await atomicWriteJSON(target, content)
      return content as T
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = resolveDir()
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await atomicWriteJSON(target, content)
    })
  }

  export async function scan(prefix: string[]): Promise<string[]> {
    const dir = resolveDir()
    const target = path.join(dir, ...prefix)
    try {
      const entries = await fs.readdir(target)
      return entries
        .filter((e) => e.endsWith(".json") && !e.endsWith(".tmp.json"))
        .map((e) => e.slice(0, -5))
        .sort()
    } catch {
      return []
    }
  }

  export async function removeTree(prefix: string[]) {
    const dir = resolveDir()
    const target = path.join(dir, ...prefix)
    await fs.rm(target, { recursive: true, force: true })
    await pruneEmptyParents(path.dirname(target), dir)
  }

  async function pruneEmptyParents(current: string, root: string) {
    while (current !== root && current.startsWith(root)) {
      try {
        const entries = await fs.readdir(current)
        if (entries.length > 0) break
        await fs.rmdir(current)
        current = path.dirname(current)
      } catch {
        break
      }
    }
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  async function atomicWriteJSON<T>(target: string, content: T) {
    const tmp = target + ".tmp"
    await Bun.write(tmp, JSON.stringify(content, null, 2))
    await fs.rename(tmp, target)
  }

  const glob = new Bun.Glob("**/*")
  export async function list(prefix: string[]) {
    const dir = resolveDir()
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) =>
        results
          .filter((x) => !x.endsWith(".tmp"))
          .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]),
      )
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
