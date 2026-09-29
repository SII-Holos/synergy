import { open } from "node:fs/promises"
import { unzipSync } from "fflate"
import { z } from "zod"
import {
  browserOrigin,
  BrowserDataRequestSchema,
  type BrowserDataRequest,
  type BrowserDataResult,
  type BrowserImportResult,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserDataStore, parseCookieImport, parsePasswordCSV } from "./browser-data-store.js"

const MAX_IMPORT_BYTES = 32 * 1024 * 1024
export async function readBrowserImport(file: string, kind: "passwords" | "cookies") {
  const handle = await open(file, "r")
  let bytes: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_IMPORT_BYTES) throw new Error("Choose a file smaller than 32 MB.")
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_IMPORT_BYTES + 1))
    let used = 0
    while (used < buffer.length) {
      const read = await handle.read(buffer, used, buffer.length - used, used)
      if (!read.bytesRead) break
      used += read.bytesRead
    }
    if (used > info.size) throw new Error("The import file changed. Choose it again.")
    bytes = buffer.subarray(0, used)
  } finally {
    await handle.close()
  }
  if (kind === "passwords" && file.toLowerCase().endsWith(".zip")) {
    let total = 0
    // Safari archive specification: https://developer.apple.com/documentation/safariservices/importing-data-exported-from-safari
    const entries = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name.split("/").at(-1)?.toLowerCase() !== "passwords.csv") return false
        total += entry.originalSize
        if (total > MAX_IMPORT_BYTES) throw new Error("Password archive is too large.")
        return true
      },
    })
    const values = Object.values(entries)
    if (values.length !== 1) throw new Error("Choose a Safari export containing one Passwords.csv file.")
    return new TextDecoder("utf-8", { fatal: true }).decode(values[0])
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

type Target = { partition: string; contents: Electron.WebContents }
export class BrowserDataActions {
  private imports = new Map<
    string,
    { ownerKey: string; pageId: string; cancelled: boolean; processed: number; total: number }
  >()
  constructor(
    private options: {
      store: BrowserDataStore
      target(ownerKey: string, pageId: string): Target
      chooseFile(kind: "passwords" | "cookies"): Promise<string | undefined>
    },
  ) {}

  async execute(input: BrowserDataRequest): Promise<BrowserDataResult> {
    const request = BrowserDataRequestSchema.parse(input)
    const action = request.action
    if (action.type === "importProgress") {
      const job = this.imports.get(action.requestId)
      return {
        type: "progress",
        processed: job?.ownerKey === request.ownerKey && job.pageId === request.pageId ? job.processed : 0,
        total: job?.ownerKey === request.ownerKey && job.pageId === request.pageId ? job.total : 0,
      }
    }
    if (action.type === "cancelImport") {
      const job = this.imports.get(action.requestId)
      if (job?.ownerKey === request.ownerKey && job.pageId === request.pageId) job.cancelled = true
      return { type: "done" }
    }
    const target = this.options.target(request.ownerKey, request.pageId)
    const { store } = this.options
    if (action.type === "state") return { type: "state", ...(await store.list(target.partition)) }
    if (action.type === "clearHistory") await store.clearHistory(target.partition)
    if (action.type === "deletePassword") await store.removePassword(target.partition, action.id)
    if (action.type === "import") return this.import(request, target, action)
    if (action.type === "saveLogin") {
      const address = target.contents.getURL()
      const origin = browserOrigin(address)
      const value: unknown = await target.contents
        .executeJavaScript(
          `(() => {
        const password = [...document.querySelectorAll('input[type="password"]')].find(input => input.value && !input.disabled && input.getClientRects().length);
        if (!password) return null;
        const scope = password.form || document;
        const username = scope.querySelector('input[autocomplete="username"], input[type="email"]') || [...scope.querySelectorAll('input[type="text"], input:not([type])')].find(input => input.value && input.getClientRects().length);
        return {username: username?.value || '', password: password.value};
      })()`,
        )
        .catch(() => {
          throw new Error("Could not read this login form. Enter your login and retry.")
        })
      const login = z
        .object({ username: z.string().max(2_000), password: z.string().min(1).max(20_000) })
        .safeParse(value)
      if (!login.success || target.contents.getURL() !== address)
        throw new Error("Enter your login in this page, then save it before submitting.")
      await store.savePassword(target.partition, { origin, ...login.data }, true)
    }
    if (action.type === "fillLogin") {
      const address = target.contents.getURL()
      const origin = browserOrigin(address)
      const login = await store.password(target.partition, action.id, origin)
      if (!login || target.contents.getURL() !== address)
        throw new Error("This login does not match the current website.")
      const filled: unknown = await target.contents
        .executeJavaScript(
          `(() => {
        if (location.href !== ${JSON.stringify(address)}) return false;
        const password = [...document.querySelectorAll('input[type="password"]')].find(input => !input.disabled && !input.readOnly && input.getClientRects().length);
        if (!password) return false;
        const scope = password.form || document;
        const username = scope.querySelector('input[autocomplete="username"], input[type="email"]') || [...scope.querySelectorAll('input[type="text"], input:not([type])')].find(input => !input.disabled && input.getClientRects().length);
        const set = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); };
        if (username) set(username, ${JSON.stringify(login.username)});
        set(password, ${JSON.stringify(login.password)});
        return true;
      })()`,
        )
        .catch(() => {
          throw new Error("Could not fill this login. Open the website’s sign-in page and retry.")
        })
      if (filled !== true) throw new Error("No login form is available on this page. Open the website's sign-in page.")
    }
    return { type: "done" }
  }

  private async import(
    request: BrowserDataRequest,
    target: Target,
    action: Extract<BrowserDataRequest["action"], { type: "import" }>,
  ): Promise<BrowserImportResult> {
    if (this.imports.has(action.requestId)) throw new Error("This import is already running.")
    const job = { ownerKey: request.ownerKey, pageId: request.pageId, cancelled: false, processed: 0, total: 0 }
    this.imports.set(action.requestId, job)
    const result: BrowserImportResult = {
      type: "import",
      imported: 0,
      skipped: 0,
      failed: 0,
      cancelled: false,
      issues: [],
    }
    const current = () => {
      if (job.cancelled) return false
      try {
        const live = this.options.target(request.ownerKey, request.pageId)
        if (live.contents === target.contents && live.partition === target.partition) return true
      } catch {}
      job.cancelled = true
      return false
    }
    const issue = (row: number, reason: BrowserImportResult["issues"][number]["reason"]) => {
      result.failed++
      if (result.issues.length < 20) result.issues.push({ row, reason })
    }
    try {
      if (action.kind === "passwords" && !(await this.options.store.list(target.partition)).passwordStorage)
        throw new Error("Unlock or configure your system password store before importing passwords.")
      const file = await this.options.chooseFile(action.kind)
      if (!file || job.cancelled) return { ...result, cancelled: true }
      let text: string
      try {
        text = await readBrowserImport(file, action.kind)
      } catch {
        throw new Error(
          "The selected file could not be read. Choose a supported CSV, Safari ZIP or Cookie JSON file under 32 MB.",
        )
      }
      if (action.kind === "passwords") {
        const rows = parsePasswordCSV(text)
        job.total = rows.length
        for (const [index, row] of rows.entries()) {
          if (!current()) break
          job.processed = index
          try {
            if (await this.options.store.savePassword(target.partition, row, action.overwrite)) result.imported++
            else result.skipped++
          } catch {
            issue(index + 1, "invalid")
          }
          if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        }
      } else {
        let rows: ReturnType<typeof parseCookieImport>
        try {
          rows = parseCookieImport(text)
        } catch {
          throw new Error("Choose a Cookie JSON array or storageState file containing a cookies array.")
        }
        const existing = await target.contents.session.cookies.get({})
        const keys = new Set(existing.map((item) => JSON.stringify([item.name, item.domain, item.path])))
        job.total = rows.length
        for (const [index, parsed] of rows.entries()) {
          if (!current()) break
          job.processed = index
          if (!parsed.success) {
            issue(index + 1, "invalid")
            continue
          }
          const entry = parsed.data
          if (entry.partitionKey !== undefined) {
            issue(index + 1, "partitioned")
            continue
          }
          if (entry.expires !== undefined && entry.expires !== -1 && entry.expires <= Date.now() / 1_000) {
            result.skipped++
            continue
          }
          const key = JSON.stringify([entry.name, entry.domain, entry.path])
          if (!action.overwrite && keys.has(key)) {
            result.skipped++
            continue
          }
          try {
            const url = new URL((entry.secure ? "https://" : "http://") + entry.domain.replace(/^\./, "") + entry.path)
            if (url.hostname !== entry.domain.replace(/^\./, "") || url.username || url.password)
              throw new Error("Invalid domain")
            await target.contents.session.cookies.set({
              url: url.href,
              name: entry.name,
              value: entry.value,
              domain: entry.domain,
              path: entry.path,
              secure: entry.secure,
              httpOnly: entry.httpOnly,
              sameSite:
                entry.sameSite === "None"
                  ? "no_restriction"
                  : entry.sameSite === "Strict"
                    ? "strict"
                    : entry.sameSite === "Lax"
                      ? "lax"
                      : "unspecified",
              ...(entry.expires !== undefined && entry.expires >= 0 ? { expirationDate: entry.expires } : {}),
            })
            keys.add(key)
            result.imported++
          } catch {
            issue(index + 1, "storage")
          }
          if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        }
        await target.contents.session.cookies.flushStore()
      }
      job.processed = result.imported + result.failed + result.skipped
      return { ...result, cancelled: job.cancelled }
    } finally {
      this.imports.delete(action.requestId)
    }
  }
}
