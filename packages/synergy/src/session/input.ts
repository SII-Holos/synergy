import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "@/id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { SessionEvent } from "./event"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Instance } from "@/scope/instance"
import { Bus } from "@/bus"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { LSP } from "@/lsp"
import { ReadTool } from "@/tool/read"
import { ListTool } from "@/tool/ls"
import { FileTime } from "@/file/time"
import { Attachment } from "@/attachment"
import { Asset } from "@/asset/asset"
import { fileURLToPath } from "bun"
import { ConfigMarkdown } from "@/config/markdown"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Tool } from "@/tool/tool"

const log = Log.create({ service: "session.input" })

export const InvokeInput = z.object({
  sessionID: Identifier.schema("session"),
  messageID: Identifier.schema("message").optional(),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  agent: z.string().optional(),
  noReply: z.boolean().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  summary: z
    .object({
      title: z.string().optional(),
    })
    .optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe("Per-prompt tool visibility toggle. Does not affect session permissions."),
  system: z.string().optional(),
  variant: z.string().optional(),
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "TextPartInput",
        }),
      MessageV2.FilePart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "FilePartInput",
        }),
    ]),
  ),
})
export type InvokeInput = z.infer<typeof InvokeInput>

export async function resolveInputParts(template: string): Promise<InvokeInput["parts"]> {
  const parts: InvokeInput["parts"] = [
    {
      type: "text",
      text: template,
    },
  ]
  const files = ConfigMarkdown.files(template)
  const seen = new Set<string>()
  await Promise.all(
    files.map(async (match) => {
      const name = match[1]
      if (seen.has(name)) return
      seen.add(name)
      const filepath = name.startsWith("~/")
        ? path.join(os.homedir(), name.slice(2))
        : path.resolve(Instance.directory, name)

      const stats = await fs.stat(filepath).catch(() => undefined)
      if (!stats) {
        return
      }

      if (stats.isDirectory()) {
        parts.push({
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "application/x-directory",
        })
        return
      }

      parts.push({
        type: "file",
        url: `file://${filepath}`,
        filename: name,
        mime: "text/plain",
      })
    }),
  )
  return parts
}

export async function lastModel(sessionID: string) {
  for await (const item of MessageV2.stream({ sessionID })) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

export async function createUserMessage(input: InvokeInput) {
  const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))
  const info: MessageV2.Info = {
    id: input.messageID ?? Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    time: {
      created: Date.now(),
    },
    tools: input.tools,
    agent: agent.name,
    model: input.model ?? (await Agent.getAvailableModel(agent)) ?? (await lastModel(input.sessionID)),
    system: input.system,
    variant: input.variant,
    ...(input.summary?.title ? { summary: { title: input.summary.title, diffs: [] } } : {}),
    metadata: {
      ...(input.noReply === true ? { noReply: true } : {}),
      ...input.metadata,
    },
  }

  const parts = await Promise.all(
    input.parts.map(async (part): Promise<MessageV2.Part[]> => {
      if (part.type === "file") {
        // before checking the protocol we check if this is an mcp resource because it needs special handling
        if (part.source?.type === "resource") {
          const { clientName, uri } = part.source
          log.info("mcp resource", { clientName, uri, mime: part.mime })

          const pieces: MessageV2.Part[] = [
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: `Reading MCP resource: ${part.filename} (${uri})`,
            },
          ]

          try {
            const resourceContent = await MCP.readResource(clientName, uri)
            if (!resourceContent) {
              throw new Error(`Resource not found: ${clientName}/${uri}`)
            }

            // Handle different content types
            const contents = Array.isArray(resourceContent.contents)
              ? resourceContent.contents
              : [resourceContent.contents]

            for (const content of contents) {
              if ("text" in content && content.text) {
                pieces.push({
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: content.text as string,
                })
              } else if ("blob" in content && content.blob) {
                // Handle binary content if needed
                const mimeType = "mimeType" in content ? content.mimeType : part.mime
                pieces.push({
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `[Binary content: ${mimeType}]`,
                })
              }
            }

            pieces.push({
              ...part,
              id: part.id ?? Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
            })
          } catch (error: unknown) {
            log.error("failed to read MCP resource", { error, clientName, uri })
            const message = error instanceof Error ? error.message : String(error)
            pieces.push({
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: `Failed to read MCP resource ${part.filename}: ${message}`,
            })
          }

          return pieces
        }
        const url = new URL(part.url)
        let filepath: string | undefined
        const protocol = (() => {
          if (url.protocol !== "asset:") return url.protocol
          filepath = Asset.resolvePath(url.hostname + url.pathname)
          if (!filepath) {
            throw new Error(`Invalid asset URL: ${part.url}`)
          }
          return "file:"
        })()
        switch (protocol) {
          case "data:":
            if (Attachment.isText(part.mime)) {
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: Attachment.decodeDataUrl(part.url).buffer.toString(),
                },
                {
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                },
              ]
            }
            const dataPolicy = Attachment.policy(part)
            if (dataPolicy.extractText) {
              const text = await Attachment.extractTextFromDataPart(part)
              const pieces: MessageV2.Part[] = [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text,
                },
              ]
              if (dataPolicy.keepBinary) {
                pieces.push({
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                })
              }
              return pieces
            }
            if (dataPolicy.saveLocal) {
              try {
                const localPath = await Attachment.saveDataPartLocally(part)
                return [
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    localPath,
                  },
                ]
              } catch (error) {
                log.error("failed to save media file to disk", { error, mime: part.mime })
              }
            }
            break
          case "file:":
            log.info(url.protocol === "asset:" ? "asset" : "file", { mime: part.mime })
            filepath = filepath ?? fileURLToPath(part.url)
            if (url.protocol === "asset:" && !(await Bun.file(filepath).exists())) {
              throw new Error(`Asset not found: ${url.hostname + url.pathname}`)
            }
            const stat = await Bun.file(filepath).stat()

            if (stat.isDirectory()) {
              part.mime = "application/x-directory"
            }

            if (Attachment.isText(part.mime)) {
              let offset: number | undefined = undefined
              let limit: number | undefined = undefined
              const range = {
                start: url.searchParams.get("start"),
                end: url.searchParams.get("end"),
              }
              if (range.start != null) {
                const filePathURI = part.url.split("?")[0]
                let start = parseInt(range.start)
                let end = range.end ? parseInt(range.end) : undefined
                // some LSP servers (eg, gopls) don't give full range in
                // workspace/symbol searches, so we'll try to find the
                // symbol in the document to get the full range
                if (start === end) {
                  const symbols = await LSP.documentSymbol(filePathURI)
                  for (const symbol of symbols) {
                    let range: LSP.Range | undefined
                    if ("range" in symbol) {
                      range = symbol.range
                    } else if ("location" in symbol) {
                      range = symbol.location.range
                    }
                    if (range?.start?.line && range?.start?.line === start) {
                      start = range.start.line
                      end = range?.end?.line ?? start
                      break
                    }
                  }
                }
                offset = Math.max(start - 1, 0)
                if (end) {
                  limit = end - offset
                }
              }
              const args = { filePath: filepath, offset, limit }

              const pieces: MessageV2.Part[] = [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                },
              ]

              await ReadTool.init()
                .then(async (t) => {
                  const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                  const readCtx: Tool.Context = {
                    sessionID: input.sessionID,
                    abort: new AbortController().signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, model },
                    metadata: async () => {},
                    ask: async () => {},
                  }
                  const result = await t.execute(args, readCtx)
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((attachment) => ({
                        ...attachment,
                        synthetic: true,
                        filename: attachment.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({
                      ...part,
                      id: part.id ?? Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                    })
                  }
                })
                .catch((error) => {
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : error.toString()
                  Bus.publish(SessionEvent.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({
                      message,
                    }).toObject(),
                  })
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                })

              return pieces
            }

            if (part.mime === "application/x-directory") {
              const args = { path: filepath }
              const listCtx: Tool.Context = {
                sessionID: input.sessionID,
                abort: new AbortController().signal,
                agent: input.agent!,
                messageID: info.id,
                extra: { bypassCwdCheck: true },
                metadata: async () => {},
                ask: async () => {},
              }
              const result = await ListTool.init().then((t) => t.execute(args, listCtx))
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: result.output,
                },
                {
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                },
              ]
            }

            const filePolicy = Attachment.policy({ filepath, filename: part.filename, mime: part.mime })
            if (filePolicy.extractText) {
              const text = await Attachment.extractTextFromFile(filepath)
              FileTime.read(input.sessionID, filepath)
              const pieces: MessageV2.Part[] = [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: filepath })}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text,
                },
              ]
              if (filePolicy.keepBinary) {
                pieces.push(
                  await Attachment.toFilePart({
                    filepath,
                    mime: part.mime,
                    filename: part.filename,
                    sessionID: input.sessionID,
                    messageID: info.id,
                    id: part.id,
                    source: part.source,
                  }),
                )
              }
              return pieces
            }

            FileTime.read(input.sessionID, filepath)
            return [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                synthetic: true,
              },
              await Attachment.toFilePart({
                filepath,
                mime: part.mime,
                filename: part.filename,
                sessionID: input.sessionID,
                messageID: info.id,
                id: part.id,
                localPath: filepath,
                source: part.source,
              }),
            ]
        }
      }

      return [
        {
          id: Identifier.ascending("part"),
          ...part,
          messageID: info.id,
          sessionID: input.sessionID,
        },
      ]
    }),
  ).then((x) => x.flat())

  await Plugin.trigger(
    "chat.message",
    {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      messageID: input.messageID,
      variant: input.variant,
    },
    {
      message: info,
      parts,
    },
  )

  if (parts.length > 0 && parts.every((p) => p.type === "text" && "synthetic" in p && p.synthetic === true)) {
    info.metadata = { ...info.metadata, synthetic: true }
  }

  const { Session } = await import(".")
  for (const part of parts) {
    await Session.updatePart(part)
  }
  await Session.updateMessage(info)

  return {
    info,
    parts,
  }
}
