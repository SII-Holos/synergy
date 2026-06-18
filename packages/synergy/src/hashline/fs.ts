/**
 * Storage seam for the hashline patcher. Filesystem is intentionally
 * minimal — `readText`, `writeText`, `exists` — so any backing store can be
 * adapted.
 */
import * as pathModule from "node:path"

export interface WriteResult {
  text: string
}

/**
 * ENOENT-like error thrown by Filesystem.readText when a path is missing.
 */
export class NotFoundError extends Error {
  readonly code = "ENOENT"

  constructor(path: string, cause?: unknown) {
    super(`File not found: ${path}`)
    this.name = "NotFoundError"
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause
  }
}

/** Type guard for NotFoundError and structurally-compatible errors. */
export function isNotFound(error: unknown): boolean {
  if (error instanceof NotFoundError) return true
  if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") return true
  return false
}

export abstract class Filesystem {
  abstract readText(path: string): Promise<string>
  async preflightWrite(_path: string): Promise<void> {}
  abstract writeText(path: string, content: string): Promise<WriteResult>

  async exists(path: string): Promise<boolean> {
    try {
      await this.readText(path)
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  canonicalPath(path: string): string {
    return path
  }
}

export class InMemoryFilesystem extends Filesystem {
  #files = new Map<string, string>()

  constructor(initial?: Iterable<readonly [string, string]>) {
    super()
    if (initial) {
      for (const [path, content] of initial) this.#files.set(path, content)
    }
  }

  override async readText(path: string): Promise<string> {
    const text = this.#files.get(path)
    if (text === undefined) throw new NotFoundError(path)
    return text
  }

  override async writeText(path: string, content: string): Promise<WriteResult> {
    this.#files.set(path, content)
    return { text: content }
  }

  override async exists(path: string): Promise<boolean> {
    return this.#files.has(path)
  }

  set(path: string, content: string): void {
    this.#files.set(path, content)
  }

  get(path: string): string | undefined {
    return this.#files.get(path)
  }

  delete(path: string): boolean {
    return this.#files.delete(path)
  }

  clear(): void {
    this.#files.clear()
  }

  entries(): IterableIterator<[string, string]> {
    return this.#files.entries()
  }
}

export class BunFilesystem extends Filesystem {
  override async readText(path: string): Promise<string> {
    const file = Bun.file(path)
    if (!(await file.exists())) throw new NotFoundError(path)
    return file.text()
  }

  override async writeText(path: string, content: string): Promise<WriteResult> {
    await Bun.write(path, content)
    return { text: content }
  }

  override canonicalPath(path: string): string {
    return pathModule.resolve(path)
  }

  override async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists()
  }
}
