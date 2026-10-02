import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { browserOrigin, redactBrowserURL } from "@ericsanchezok/synergy-browser-core"

const credential = z
  .object({ id: z.string(), origin: z.string(), username: z.string().max(2_000), encrypted: z.string().max(100_000) })
  .strict()
const state = z
  .object({
    version: z.literal(1),
    passwords: z.array(credential).max(10_000),
    history: z.array(z.object({ url: z.string(), title: z.string(), time: z.number() })).max(100),
  })
  .strict()
type State = z.infer<typeof state>
export type ImportedPassword = { origin: string; username: string; password: string }
export type BrowserEncryption = {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

export class BrowserDataStore {
  private revisions = new Map<string, number>()
  private queues = new Map<string, Promise<unknown>>()
  constructor(
    private root: string,
    private encryption: BrowserEncryption,
  ) {}
  file(partition: string) {
    return path.join(this.root, createHash("sha256").update(partition).digest("hex") + ".json")
  }
  async list(partition: string) {
    await this.queues.get(partition)?.catch(() => undefined)
    const value = await this.read(partition)
    return {
      passwords: value.passwords.map(({ encrypted: _encrypted, ...entry }) => entry),
      history: value.history,
      passwordStorage: partition.startsWith("persist:") && (await this.encryption.available()),
    }
  }
  async password(partition: string, id: string, origin: string): Promise<ImportedPassword | undefined> {
    if (!(await this.encryption.available())) throw new Error("Unlock the system password store, then retry.")
    const entry = (await this.read(partition)).passwords.find((entry) => entry.id === id && entry.origin === origin)
    if (!entry) return
    return {
      origin,
      username: entry.username,
      password: await this.encryption.decrypt(Buffer.from(entry.encrypted, "base64")),
    }
  }
  async savePassword(partition: string, input: ImportedPassword, overwrite: boolean) {
    const revision = this.revisions.get(partition) ?? 0
    if (!partition.startsWith("persist:") || !(await this.encryption.available()))
      throw new Error("A persistent browser profile and system password store are required.")
    const origin = browserOrigin(input.origin)
    if (!input.password || input.password.length > 20_000 || input.username.length > 2_000)
      throw new Error("Password entry is invalid.")
    const encrypted = (await this.encryption.encrypt(input.password)).toString("base64")
    return this.mutate(partition, (value) => {
      if (revision !== (this.revisions.get(partition) ?? 0))
        throw new Error("Browser profile was cleared. Reopen it before saving passwords.")
      const previous = value.passwords.find((entry) => entry.origin === origin && entry.username === input.username)
      if (previous && !overwrite) return false
      if (previous) previous.encrypted = encrypted
      else {
        if (value.passwords.length >= 10_000) throw new Error("Saved password limit reached.")
        value.passwords.push({ id: randomUUID(), origin, username: input.username, encrypted })
      }
      return true
    })
  }
  removePassword(partition: string, id: string) {
    return this.mutate(partition, (value) => {
      value.passwords = value.passwords.filter((entry) => entry.id !== id)
    })
  }
  clearHistory(partition: string) {
    return this.mutate(partition, (value) => {
      value.history = []
    })
  }
  clear(partition: string) {
    this.revisions.set(partition, (this.revisions.get(partition) ?? 0) + 1)
    return this.mutate(partition, (value) => {
      value.history = []
      value.passwords = []
    })
  }
  visit(partition: string, address: string, title: string) {
    if (!partition.startsWith("persist:") || !/^https?:\/\//.test(address)) return Promise.resolve()
    const url = redactBrowserURL(address).slice(0, 20_000)
    return this.mutate(partition, (value) => {
      value.history = [
        { url, title: title.slice(0, 1_000), time: Date.now() },
        ...value.history.filter((entry) => entry.url !== url),
      ].slice(0, 100)
    })
  }
  private async read(partition: string): Promise<State> {
    if (!partition.startsWith("persist:")) return { version: 1, passwords: [], history: [] }
    try {
      return state.parse(JSON.parse(await readFile(this.file(partition), "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, passwords: [], history: [] }
      throw new Error("Browser data could not be read. Existing data has been preserved.")
    }
  }
  private mutate<T>(partition: string, operation: (value: State) => T): Promise<T> {
    const run = (this.queues.get(partition) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const value = await this.read(partition)
        const result = operation(value)
        if (!partition.startsWith("persist:")) return result
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        const temporary = this.file(partition) + "." + randomUUID() + ".tmp"
        await writeFile(temporary, JSON.stringify(state.parse(value)), { mode: 0o600, flag: "wx" })
        try {
          await rename(temporary, this.file(partition))
        } finally {
          await unlink(temporary).catch(() => undefined)
        }
        return result
      })
    this.queues.set(partition, run)
    void run
      .finally(() => {
        if (this.queues.get(partition) === run) this.queues.delete(partition)
      })
      .catch(() => undefined)
    return run
  }
}

// Browser export columns: https://support.google.com/chrome/answer/13068232 and https://developer.apple.com/documentation/safariservices/importing-data-exported-from-safari
export function parsePasswordCSV(text: string): ImportedPassword[] {
  if (text.length > 32 * 1024 * 1024) throw new Error("Import file is too large.")
  const rows: string[][] = []
  let row: string[] = [],
    field = "",
    quoted = false
  text = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = !quoted
    } else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
      row.push(field)
      field = ""
      if (char !== ",") {
        if (row.some(Boolean)) rows.push(row)
        row = []
        if (char === "\r" && text[i + 1] === "\n") i++
      }
    } else field += char
    if (rows.length > 10_001 || field.length > 100_000) throw new Error("Import file exceeds the supported limit.")
  }
  if (quoted) throw new Error("CSV has an incomplete quoted field.")
  row.push(field)
  if (row.some(Boolean)) rows.push(row)
  if (rows.length > 10_001) throw new Error("Import file exceeds the supported limit.")
  const headers = rows.shift()?.map((name) => name.trim().toLowerCase()) ?? []
  const url = headers.indexOf("url"),
    username = headers.indexOf("username"),
    password = headers.indexOf("password")
  if ([url, username, password].some((index) => index < 0))
    throw new Error("Choose a browser password CSV with URL, username and password columns.")
  return rows
    .map((row) => ({ origin: row[url] ?? "", username: row[username] ?? "", password: row[password] ?? "" }))
    .map((entry) => {
      try {
        return { ...entry, origin: browserOrigin(entry.origin) }
      } catch {
        return entry
      }
    })
}

const cookie = z.object({
  name: z.string().min(1).max(2_000),
  value: z.string().max(100_000),
  domain: z.string().min(1).max(2_000),
  path: z.string().max(2_000),
  expires: z.number().finite().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  partitionKey: z.unknown().optional(),
})
// Accepted interchange shape: https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state
export function parseCookieImport(text: string) {
  if (text.length > 32 * 1024 * 1024) throw new Error("Import file is too large.")
  const input: unknown = JSON.parse(text)
  const rows = Array.isArray(input)
    ? input
    : input && typeof input === "object" && "cookies" in input
      ? input.cookies
      : undefined
  return z
    .array(z.unknown())
    .max(10_000)
    .parse(rows)
    .map((row) => cookie.safeParse(row))
}
