import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import type { BrowserImportKind, BrowserImportSource } from "@ericsanchezok/synergy-browser-core"
import type { ImportedPassword } from "./browser-data-store.js"

type Database = { prepare(sql: string): { all(): unknown[] }; close(): void }
type Source = {
  public: BrowserImportSource
  directory: string
  canonicalDirectory: string
  service: string
  files: Partial<Record<BrowserImportKind, string[]>>
}
export type NativeImportBatch = {
  kind: BrowserImportKind
  rows: unknown[]
  failed: number
  error?: "unavailable" | "format"
}
const browsers = [
  { browser: "chrome", directory: "Google/Chrome", service: "Chrome Safe Storage" },
  { browser: "edge", directory: "Microsoft Edge", service: "Microsoft Edge Safe Storage" },
  { browser: "brave", directory: "BraveSoftware/Brave-Browser", service: "Brave Safe Storage" },
] as const
const metadata = z.object({
  profile: z.object({ info_cache: z.record(z.string(), z.object({ name: z.string().max(200).optional() })) }),
})
const blob = z.instanceof(Uint8Array).transform((value) => Buffer.from(value))
const passwordRow = z.object({
  origin_url: z.string().max(20_000),
  username_value: z.string().max(2_000),
  password_value: blob,
})
const cookieRow = z.object({
  host_key: z.string().min(1).max(1_000),
  name: z.string().max(4_000),
  value: z.string().max(64_000),
  encrypted_value: blob,
  path: z.string().max(4_000),
  expires_utc: z.number().finite(),
  is_secure: z.number(),
  is_httponly: z.number(),
  samesite: z.number().min(-1).max(2),
  top_frame_site_key: z.string().max(4_000),
})

async function boundedText(file: string, limit: number) {
  const handle = await open(file, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error("Source is too large.")
    const bytes = Buffer.alloc(info.size + 1)
    let used = 0
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used)
      if (!read.bytesRead) break
      used += read.bytesRead
    }
    if (used > info.size) throw new Error("Source changed.")
    return bytes.subarray(0, used).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function regularFile(file: string) {
  try {
    const stat = await lstat(file)
    return stat.isFile() && stat.size <= 128 * 1024 * 1024
  } catch {
    return false
  }
}

function keychain(service: string, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service],
      { encoding: "buffer", maxBuffer: 16_384, timeout: 120_000, signal },
      (error, stdout) => {
        if (error || !stdout.length) {
          stdout?.fill(0)
          reject(new Error("Browser access was not granted. Retry or import an exported file."))
          return
        }
        const end = stdout.at(-1) === 10 ? stdout.length - 1 : stdout.length
        const secret = Buffer.from(stdout.subarray(0, end))
        stdout.fill(0)
        resolve(secret)
      },
    )
  })
}

// Chromium's current macOS key and value formats; never interpret an unknown encrypted version as plaintext.
// https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/async/browser/keychain_key_provider.mm
// https://chromium.googlesource.com/chromium/src/+/main/net/extras/sqlite/sqlite_persistent_cookie_store.cc
function decrypt(value: Buffer, key: Buffer, host?: string) {
  if (value.length > 64_000 || value.subarray(0, 3).toString() !== "v10") throw new Error("Unsupported encryption.")
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32))
  const plain = Buffer.concat([decipher.update(value.subarray(3)), decipher.final()])
  try {
    if (host !== undefined) {
      const hash = createHash("sha256").update(host).digest()
      if (plain.length < hash.length || !timingSafeEqual(plain.subarray(0, hash.length), hash))
        throw new Error("Cookie binding mismatch.")
      return new TextDecoder("utf-8", { fatal: true }).decode(plain.subarray(hash.length))
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(plain)
  } finally {
    plain.fill(0)
  }
}

export class BrowserImportSources {
  private sources = new Map<string, Source>()
  constructor(
    private options: {
      home?: string
      platform?: NodeJS.Platform
      readKey?(service: string, signal: AbortSignal): Promise<Buffer>
      openDatabase?(file: string): Promise<Database>
    } = {},
  ) {}

  async list(): Promise<BrowserImportSource[]> {
    const found = new Map<string, Source>()
    if ((this.options.platform ?? process.platform) === "darwin") {
      for (const browser of browsers) {
        const root = path.join(this.options.home ?? homedir(), "Library/Application Support", browser.directory)
        try {
          const canonicalRoot = await realpath(root)
          const parsed = metadata.safeParse(
            JSON.parse(await boundedText(path.join(root, "Local State"), 8 * 1024 * 1024)),
          )
          if (!parsed.success) continue
          for (const [folder, profile] of Object.entries(parsed.data.profile.info_cache).slice(0, 100)) {
            if (!/^(Default|Profile \d+)$/.test(folder)) continue
            const directory = path.join(root, folder)
            if (
              !(await lstat(directory).catch(() => undefined))?.isDirectory() ||
              (await realpath(directory)) !== path.join(canonicalRoot, folder)
            )
              continue
            const files: Source["files"] = {}
            for (const candidate of ["Login Data", "Login Data For Account"]) {
              const file = path.join(directory, candidate)
              if ((await regularFile(file)) && (await realpath(file)) === path.join(canonicalRoot, folder, candidate))
                (files.passwords ??= []).push(file)
            }
            for (const candidate of ["Network/Cookies", "Cookies"]) {
              const file = path.join(directory, candidate)
              if ((await regularFile(file)) && (await realpath(file)) === path.join(canonicalRoot, folder, candidate)) {
                files.cookies = [file]
                break
              }
            }
            const kinds = (["passwords", "cookies"] as const).filter((kind) => files[kind])
            if (!kinds.length) continue
            const id = createHash("sha256").update(directory).digest("hex")
            found.set(id, {
              public: { id, browser: browser.browser, profile: profile.name || folder, mode: "direct", kinds },
              directory,
              canonicalDirectory: path.join(canonicalRoot, folder),
              files,
              service: browser.service,
            })
          }
        } catch {
          continue
        }
      }
    }
    this.sources = found
    return [
      ...[...found.values()].map((source) => source.public),
      ...((this.options.platform ?? process.platform) === "darwin"
        ? [{ id: "safari", browser: "safari" as const, mode: "file" as const, kinds: ["passwords" as const] }]
        : []),
      { id: "file", browser: "file", mode: "file", kinds: ["passwords", "cookies"] },
    ]
  }

  async read(id: string, kinds: BrowserImportKind[], signal: AbortSignal): Promise<NativeImportBatch[]> {
    signal.throwIfAborted()
    const source = this.sources.get(id)
    if (!source || kinds.some((kind) => !source.public.kinds.includes(kind)))
      throw new Error("Browser source is unavailable. Choose it again.")
    const validate = async (file: string) => {
      if (
        !(await regularFile(file)) ||
        (await realpath(source.directory)) !== source.canonicalDirectory ||
        (await realpath(file)) !== path.join(source.canonicalDirectory, path.relative(source.directory, file))
      )
        throw new Error("Browser source changed. Choose it again.")
    }
    for (const kind of kinds) for (const file of source.files[kind]!) await validate(file)
    let secret: Buffer
    try {
      secret = await (this.options.readKey ?? keychain)(source.service, signal)
    } catch {
      throw new Error("Browser access was not granted. Retry or import an exported file.")
    }
    const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1")
    secret.fill(0)
    try {
      const batches: NativeImportBatch[] = []
      for (const kind of kinds) {
        signal.throwIfAborted()
        const batch: NativeImportBatch = { kind, rows: [], failed: 0 }
        let bytes = 0
        for (const file of source.files[kind]!) {
          let db: Database | undefined
          try {
            signal.throwIfAborted()
            await validate(file)
            db = await (
              this.options.openDatabase ??
              (async (file) => {
                const { DatabaseSync } = await import("node:sqlite")
                return new DatabaseSync(file, { readOnly: true })
              })
            )(file)
            db.prepare("BEGIN").all()
            const query =
              kind === "passwords"
                ? "SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0 LIMIT 10001"
                : "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, top_frame_site_key FROM cookies LIMIT 10001"
            const sizes =
              kind === "passwords"
                ? "length(CAST(origin_url AS BLOB)) + length(CAST(username_value AS BLOB)) + length(password_value)"
                : "length(CAST(host_key AS BLOB)) + length(CAST(name AS BLOB)) + length(CAST(value AS BLOB)) + length(encrypted_value) + length(CAST(path AS BLOB)) + length(CAST(top_frame_site_key AS BLOB))"
            const budget = z
              .object({ count: z.number(), bytes: z.number().nullable() })
              .parse(db.prepare(`SELECT count(*) AS count, sum(${sizes}) AS bytes FROM (${query})`).all()[0])
            if (
              budget.count + batch.rows.length + batch.failed > 10_000 ||
              (budget.bytes ?? 0) + bytes > 32 * 1024 * 1024
            )
              throw new Error("Import exceeds the supported limit.")
            const version =
              kind === "cookies"
                ? Number(
                    z
                      .object({ value: z.union([z.string(), z.number()]) })
                      .parse(db.prepare("SELECT value FROM meta WHERE key = 'version'").all()[0]).value,
                  )
                : 0
            if (kind === "cookies" && (!Number.isInteger(version) || version !== 24))
              throw new Error("Unsupported cookie database.")
            const rows = db.prepare(query).all()
            for (const [index, raw] of rows.entries()) {
              signal.throwIfAborted()
              try {
                if (kind === "passwords") {
                  const row = passwordRow.parse(raw)
                  const value: ImportedPassword = {
                    origin: row.origin_url,
                    username: row.username_value,
                    password: decrypt(row.password_value, key),
                  }
                  bytes += value.origin.length + value.username.length + value.password.length
                  batch.rows.push(value)
                } else {
                  const row = cookieRow.parse(raw)
                  if (row.encrypted_value.length && row.value) throw new Error("Ambiguous cookie value.")
                  const value = row.encrypted_value.length ? decrypt(row.encrypted_value, key, row.host_key) : row.value
                  bytes += value.length + row.host_key.length + row.name.length + row.path.length
                  batch.rows.push({
                    domain: row.host_key,
                    name: row.name,
                    value,
                    path: row.path,
                    expires: row.expires_utc ? row.expires_utc / 1_000_000 - 11_644_473_600 : -1,
                    secure: Boolean(row.is_secure),
                    httpOnly: Boolean(row.is_httponly),
                    sameSite: ["None", "Lax", "Strict"][row.samesite] ?? undefined,
                    ...(row.top_frame_site_key ? { partitionKey: row.top_frame_site_key } : {}),
                  })
                }
              } catch {
                batch.failed++
              }
              if (bytes > 32 * 1024 * 1024) throw new Error("Too much data.")
              if (index % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
            }
          } catch {
            signal.throwIfAborted()
            batch.error = "unavailable"
          } finally {
            try {
              db?.prepare("ROLLBACK").all()
            } catch {}
            db?.close()
          }
        }
        batches.push(batch)
      }
      return batches
    } finally {
      key.fill(0)
    }
  }
}
