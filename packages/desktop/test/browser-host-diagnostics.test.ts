import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { BROWSER_MAX_DOWNLOAD_BYTES } from "@ericsanchezok/synergy-browser"
import { BrowserHostDiagnostics, type BrowserHostUploadFile } from "../src/browser-host-diagnostics.js?real"

interface SendCommandRecord {
  method: string
  params: Record<string, unknown>
}

class MockDebugger extends EventEmitter {
  attached = false
  attachVersion: string | undefined
  commands: SendCommandRecord[] = []

  isAttached() {
    return this.attached
  }

  attach(version: string) {
    this.attachVersion = version
    this.attached = true
  }

  detach() {
    this.attached = false
  }

  async sendCommand(method: string, params?: Record<string, unknown>) {
    this.commands.push({ method, params: params ?? {} })
    return {}
  }
}

class MockDownloadItem extends EventEmitter {
  savePath: string | undefined
  filename = "report.pdf"
  mimeType = "application/pdf"
  url = "https://example.com/report.pdf?token=secret"
  totalBytes = 1024
  receivedBytes = 512
  pauses = 0
  resumes = 0
  cancels = 0

  pause() {
    this.pauses++
  }

  resume() {
    this.resumes++
  }

  cancel() {
    this.cancels++
  }

  getSavePath() {
    return this.savePath
  }

  setSavePath(target: string) {
    this.savePath = target
  }

  getFilename() {
    return this.filename
  }

  getMimeType() {
    return this.mimeType
  }

  getURL() {
    return this.url
  }

  getTotalBytes() {
    return this.totalBytes
  }

  getReceivedBytes() {
    return this.receivedBytes
  }
}

class MockSession extends EventEmitter {
  setPermissionCheckHandlerCalls: unknown[] = []
  setPermissionRequestHandlerCalls: unknown[] = []

  setPermissionCheckHandler(handler: unknown) {
    this.setPermissionCheckHandlerCalls.push(handler)
  }

  setPermissionRequestHandler(handler: unknown) {
    this.setPermissionRequestHandlerCalls.push(handler)
  }
}

class MockContents extends EventEmitter {
  readonly debugger: MockDebugger
  destroyed = false
  readonly id = 42

  constructor(readonly session: MockSession) {
    super()
    this.debugger = new MockDebugger()
  }

  isDestroyed() {
    return this.destroyed
  }
}

interface Fixture {
  contents: MockContents
  session: MockSession
  events: unknown[]
  downloadDir: string
  diagnostics: BrowserHostDiagnostics
  item: MockDownloadItem
}

async function createFixture(options: { downloadDir?: string; start?: boolean } = {}): Promise<Fixture> {
  const session = new MockSession()
  const contents = new MockContents(session)
  const events: unknown[] = []
  const downloadDir = options.downloadDir ?? (await mkdtemp(path.join(import.meta.dir, ".diagnostics-dl-")))
  const diagnostics = new BrowserHostDiagnostics({
    pageId: "page-1",
    contents: contents as never,
    downloadDir,
    emitHostEvent: (event) => events.push(event),
  })
  if (options.start !== false) await diagnostics.start()
  const item = new MockDownloadItem()
  return { contents, session, events, downloadDir, diagnostics, item }
}

interface TrackedDownloadEntry {
  id: string
  state: string
  fileName: string
  path: string
}

async function untilTrackedDownload(fixture: Fixture): Promise<TrackedDownloadEntry> {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    const event = fixture.events.at(-1) as { type: string; entry: Partial<TrackedDownloadEntry> } | undefined
    if (event?.type === "download.updated" && event.entry.path) {
      return event.entry as TrackedDownloadEntry
    }
    await Bun.sleep(1)
  }
  throw new Error("tracked download event timed out")
}

async function untilDownloadEvent(
  fixture: Fixture,
  match: (entry: { state: string; warning: string }) => boolean,
): Promise<{ entry: { state: string; warning: string } }> {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    const event = fixture.events.at(-1) as { type: string; entry: { state: string; warning: string } } | undefined
    if (event?.type === "download.updated" && match(event.entry)) return event
    await Bun.sleep(1)
  }
  throw new Error("terminal download event timed out")
}

let fixtures: Array<{ downloadDir: string }> = []

afterEach(async () => {
  for (const fixture of fixtures) await rm(fixture.downloadDir, { recursive: true, force: true })
  fixtures = []
})

describe("Browser Host diagnostics", () => {
  test("installs content permissions, subscribes downloads, and enables CDP domains on start", async () => {
    const fixture = await createFixture({ start: false })
    fixtures.push(fixture)
    expect(fixture.session.setPermissionCheckHandlerCalls).toHaveLength(0)

    await fixture.diagnostics.start()

    expect(fixture.session.setPermissionCheckHandlerCalls).toHaveLength(1)
    expect(fixture.session.setPermissionRequestHandlerCalls).toHaveLength(1)
    expect(fixture.session.listenerCount("will-download")).toBe(1)
    expect(fixture.contents.debugger.attachVersion).toBe("1.3")
    expect(fixture.contents.debugger.commands.map((command) => command.method)).toEqual([
      "Page.enable",
      "DOM.enable",
      "Page.setInterceptFileChooserDialog",
    ])
  })

  test("turns JavaScript dialog messages into host events and responds through CDP", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.contents.debugger.emit("message", {} as never, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Proceed?",
      defaultPrompt: "yes",
    })

    expect(fixture.events).toHaveLength(1)
    const opened = fixture.events[0] as { type: string; requestId: string; dialogType: string; message: string }
    expect(opened.type).toBe("dialog.opened")
    expect(opened.dialogType).toBe("confirm")
    expect(opened.message).toBe("Proceed?")

    await fixture.diagnostics.respondToDialog(opened.requestId, true, "yes")
    expect(fixture.contents.debugger.commands.at(-1)).toEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: true, promptText: "yes" },
    })

    await expect(fixture.diagnostics.respondToDialog("missing", true)).rejects.toThrow("no longer available")
  })

  test("stages file chooser uploads and scopes them to the intercepted backend node", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.contents.debugger.emit("message", {} as never, "Page.fileChooserOpened", {
      mode: "selectMultiple",
      backendNodeId: 7,
    })

    expect(fixture.events).toHaveLength(1)
    const opened = fixture.events[0] as { type: string; requestId: string; multiple: boolean }
    expect(opened.type).toBe("filechooser.request")
    expect(opened.multiple).toBe(true)

    await fixture.diagnostics.respondToFileChooser(opened.requestId, [
      { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello world").toString("base64") },
    ])

    const command = fixture.contents.debugger.commands.at(-1)!
    expect(command.method).toBe("DOM.setFileInputFiles")
    const files = command.params.files as string[]
    expect(files).toHaveLength(1)
    expect(await readFile(files[0]!, "utf8")).toBe("hello world")
    expect(command.params.backendNodeId).toBe(7)

    await expect(fixture.diagnostics.respondToFileChooser("missing", [])).rejects.toThrow("no longer available")
  })

  test("rejects oversized upload batches and files over the staging limits", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    const file: BrowserHostUploadFile = { name: "a.txt", data: Buffer.from("x").toString("base64") }
    await expect(fixture.diagnostics.stageFiles(Array.from({ length: 21 }, () => file))).rejects.toThrow("at most 20")

    const big = { name: "big.bin", data: Buffer.alloc(26 * 1024 * 1024, "a").toString("base64") }
    await expect(fixture.diagnostics.stageFiles([big])).rejects.toThrow("25 MB per-file")

    await expect(fixture.diagnostics.stageFiles([{ name: "bad.txt", data: "%%%not-base64%%%" }])).rejects.toThrow(
      "invalid base64",
    )

    const staged = await fixture.diagnostics.stageFiles([{ name: "../escape.txt", data: "aGVsbG8=" }])
    expect(staged.paths).toHaveLength(1)
    expect(path.basename(staged.paths[0]!)).not.toContain("..")
    await staged.cleanup()
  })

  test("blocks dangerous downloads before they ever reach disk", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.item.filename = "setup.exe"
    fixture.session.emit("will-download", {} as never, fixture.item, fixture.contents)

    expect(fixture.item.pauses).toBe(1)
    expect(fixture.item.cancels).toBe(1)
    const event = fixture.events.at(-1) as { type: string; entry: { state: string; warning: string } }
    expect(event.type).toBe("download.updated")
    expect(event.entry.state).toBe("blocked")
    expect(event.entry.warning).toContain("safety policy")
  })

  test("blocks downloads that exceed the browser limit", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.item.totalBytes = BROWSER_MAX_DOWNLOAD_BYTES + 1
    fixture.session.emit("will-download", {} as never, fixture.item, fixture.contents)

    const event = fixture.events.at(-1) as { type: string; entry: { state: string; warning: string } }
    expect(event.entry.state).toBe("blocked")
    expect(event.entry.warning).toContain("exceeds")
  })

  test("manages a clean download to completion and reports interruption on failure", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.session.emit("will-download", {} as never, fixture.item, fixture.contents)
    const tracked = await untilTrackedDownload(fixture)

    expect(fixture.item.savePath).toBeDefined()
    expect(fixture.item.resumes).toBe(1)
    expect(tracked.state).toBe("in_progress")
    expect(tracked.fileName).toBe("report.pdf")

    fixture.item.emit("updated", {} as never, "interrupted")
    fixture.item.emit("done", {} as never, "completed")
    const done = fixture.events.at(-1) as { entry: { state: string } }
    expect(done.entry.state).toBe("completed")

    await expect(fixture.diagnostics.cancelDownload(tracked.id)).rejects.toThrow("no longer active")
  })

  test("cancels downloads with their emitted id and removes the managed path", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.session.emit("will-download", {} as never, fixture.item, fixture.contents)
    const entry = await untilTrackedDownload(fixture)
    await fixture.diagnostics.cancelDownload(entry.id)
    expect(fixture.item.cancels).toBe(1)
    expect(await Bun.file(entry.path).exists()).toBe(false)
  })

  test("disposes listeners, permissions, debugger attachment, and pending downloads", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.session.emit("will-download", {} as never, fixture.item, fixture.contents)
    await untilTrackedDownload(fixture)

    await fixture.diagnostics.dispose()

    expect(fixture.session.listenerCount("will-download")).toBe(0)
    expect(fixture.contents.debugger.attached).toBe(false)
    expect(fixture.item.cancels).toBe(1)
    expect(fixture.contents.debugger.listenerCount("message")).toBe(0)
  })

  test("refuses unavailable or unsafe download roots", async () => {
    const missingRoot = await createFixture({ downloadDir: path.join(import.meta.dir, "no-such-download-dir") })
    fixtures.push(missingRoot)
    missingRoot.session.emit("will-download", {} as never, missingRoot.item, missingRoot.contents)
    const event = await untilDownloadEvent(missingRoot, (entry) => entry.state === "interrupted")
    expect(event.entry.warning).toContain("ENOENT")

    const fileRoot = await mkdtemp(path.join(import.meta.dir, ".diagnostics-file-"))
    fixtures.push({ downloadDir: fileRoot })
    const filePath = path.join(fileRoot, "not-a-dir")
    await Bun.write(filePath, "x")
    const fileFixture = await createFixture({ downloadDir: filePath })
    fixtures.push(fileFixture)
    fileFixture.session.emit("will-download", {} as never, fileFixture.item, fileFixture.contents)
    const fileEvent = await untilDownloadEvent(fileFixture, (entry) => entry.state === "interrupted")
    expect(fileEvent.entry.warning).toContain("unsafe")
  })

  test("writes uploaded files with restricted permissions and cleans up on failure", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    const staged = await fixture.diagnostics.stageFiles([
      { name: "a.txt", data: Buffer.from("one").toString("base64") },
      { name: "b.txt", data: Buffer.from("two").toString("base64") },
    ])
    expect(staged.paths).toHaveLength(2)
    const uploadDir = path.dirname(staged.paths[0]!)
    expect((await stat(uploadDir)).mode & 0o777).toBe(0o700)
    const entries = (await readdir(uploadDir)).toSorted()
    expect(entries.length).toBe(2)

    await staged.cleanup()
    expect(await Bun.file(uploadDir).exists()).toBe(false)
  })

  test("blocks downloads by mime type even with a safe extension", async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)

    fixture.item.filename = "payload.txt"
    fixture.item.mimeType = "application/x-msdownload"
    fixture.session.emit("will-download", {} as never, fixture.item, fixture.contents)
    const event = fixture.events.at(-1) as { entry: { state: string; warning: string } }
    expect(event.entry.state).toBe("blocked")
    expect(event.entry.warning).toContain("payload.txt")
  })
})
