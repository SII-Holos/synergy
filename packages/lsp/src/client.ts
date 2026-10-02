import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import path from "path"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { LANGUAGE_EXTENSIONS } from "./language"
import z from "zod"
import type { LSPServer } from "./server"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { withTimeout } from "@ericsanchezok/synergy-harness/util/timeout"
import { Filesystem } from "@ericsanchezok/synergy-harness/util/filesystem"
import { Shell } from "@ericsanchezok/synergy-harness/util/shell"
import { FileView } from "@ericsanchezok/synergy-local-runtime/file/view"
import { LSPPaths } from "./paths"

const DIAGNOSTICS_DEBOUNCE_MS = 150

export namespace LSPClient {
  const log = Log.create({ service: "lsp.client" })

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

  export type Diagnostic = VSCodeDiagnostic

  export const InitializeError = NamedError.create(
    "LSPInitializeError",
    z.object({
      serverID: z.string(),
    }),
  )

  export const Event = {
    Diagnostics: BusEvent.define(
      "lsp.client.diagnostics",
      z.object({
        serverID: z.string(),
        path: z.string(),
      }),
    ),
  }

  export async function create(input: {
    serverID: string
    server: LSPServer.Handle
    root: string
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()
    const l = log.clone().tag("serverID", input.serverID)
    l.info("starting client")

    const connection = createMessageConnection(
      new StreamMessageReader(input.server.process.stdout as any),
      new StreamMessageWriter(input.server.process.stdin as any),
    )
    connection.onClose(() => connection.dispose())

    const diagnostics = new Map<string, Diagnostic[]>()
    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const filePath = Filesystem.normalizePath(LSPPaths.path(params.uri))
      l.info("textDocument/publishDiagnostics", {
        path: filePath,
        count: params.diagnostics.length,
      })
      const exists = diagnostics.has(filePath)
      diagnostics.set(filePath, params.diagnostics)
      if (!exists && input.serverID === "typescript") return
      Bus.publish(Event.Diagnostics, { path: filePath, serverID: input.serverID })
    })
    connection.onRequest("window/workDoneProgress/create", (params) => {
      l.info("window/workDoneProgress/create", params)
      return null
    })
    connection.onRequest("workspace/configuration", async () => {
      // Return server initialization options
      return [input.server.initialization ?? {}]
    })
    connection.onRequest("client/registerCapability", async () => {})
    connection.onRequest("client/unregisterCapability", async () => {})
    connection.onRequest("workspace/workspaceFolders", async () => [
      {
        name: "workspace",
        uri: LSPPaths.url(input.root),
      },
    ])
    connection.listen()

    const abort = () => connection.dispose()
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted) abort()
    l.info("sending initialize")
    await withTimeout(
      connection.sendRequest("initialize", {
        rootUri: LSPPaths.url(input.root),
        processId: input.server.process.pid,
        workspaceFolders: [
          {
            name: "workspace",
            uri: LSPPaths.url(input.root),
          },
        ],
        initializationOptions: {
          ...input.server.initialization,
        },
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            publishDiagnostics: {
              versionSupport: true,
            },
          },
        },
      }),
      45_000,
    )
      .catch((err) => {
        connection.dispose()
        l.error("initialize error", { error: err })
        throw new InitializeError(
          { serverID: input.serverID },
          {
            cause: err,
          },
        )
      })
      .finally(() => input.signal?.removeEventListener("abort", abort))
    input.signal?.throwIfAborted()

    await connection.sendNotification("initialized", {})

    if (input.server.initialization) {
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: input.server.initialization,
      })
    }

    const files: {
      [path: string]: number
    } = {}

    let shutdown: Promise<void> | undefined
    const result = {
      root: input.root,
      get pid() {
        return input.server.process.pid
      },
      get serverID() {
        return input.serverID
      },
      get connection() {
        return connection
      },
      notify: {
        async open(input: { path: string }) {
          input.path = FileView.resolve(input.path)
          const text = new TextDecoder().decode(await FileView.bytes(input.path))
          const extension = path.extname(input.path)
          const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

          const version = files[input.path]
          if (version !== undefined) {
            log.info("workspace/didChangeWatchedFiles", input)
            await connection.sendNotification("workspace/didChangeWatchedFiles", {
              changes: [
                {
                  uri: LSPPaths.url(input.path),
                  type: 2, // Changed
                },
              ],
            })

            const next = version + 1
            files[input.path] = next
            log.info("textDocument/didChange", {
              path: input.path,
              version: next,
            })
            await connection.sendNotification("textDocument/didChange", {
              textDocument: {
                uri: LSPPaths.url(input.path),
                version: next,
              },
              contentChanges: [{ text }],
            })
            return
          }

          log.info("workspace/didChangeWatchedFiles", input)
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: LSPPaths.url(input.path),
                type: 1, // Created
              },
            ],
          })

          log.info("textDocument/didOpen", input)
          diagnostics.delete(input.path)
          await connection.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri: LSPPaths.url(input.path),
              languageId,
              version: 0,
              text,
            },
          })
          files[input.path] = 0
          return
        },
      },
      get diagnostics() {
        return diagnostics
      },
      async waitForDiagnostics(input: { path: string }) {
        const normalizedPath = Filesystem.normalizePath(FileView.resolve(input.path))
        log.info("waiting for diagnostics", { path: normalizedPath })
        let unsub: () => void
        let debounceTimer: ReturnType<typeof setTimeout> | undefined
        return await withTimeout(
          new Promise<void>((resolve) => {
            unsub = Bus.subscribe(Event.Diagnostics, (event) => {
              if (event.properties.path === normalizedPath && event.properties.serverID === result.serverID) {
                // Debounce to allow LSP to send follow-up diagnostics (e.g., semantic after syntax)
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = setTimeout(() => {
                  log.info("got diagnostics", { path: normalizedPath })
                  unsub?.()
                  resolve()
                }, DIAGNOSTICS_DEBOUNCE_MS)
              }
            })
          }),
          3000,
        )
          .catch(() => {})
          .finally(() => {
            if (debounceTimer) clearTimeout(debounceTimer)
            unsub?.()
          })
      },
      shutdown() {
        return (shutdown ??= (async () => {
          l.info("shutting down")
          try {
            await withTimeout(connection.sendRequest("shutdown"), 5000)
            await connection.sendNotification("exit")
          } catch {
            // A stalled protocol still needs native process-tree termination.
          } finally {
            connection.end()
            connection.dispose()
            input.server.process.stdout.resume()
            input.server.process.stderr.resume()
            await Shell.killTree(input.server.process)
          }
          l.info("shutdown")
        })())
      },
    }

    l.info("initialized")

    return result
  }
}
