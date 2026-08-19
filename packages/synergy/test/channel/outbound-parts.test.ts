import { describe, expect, test } from "bun:test"
import { Asset } from "../../src/asset/asset"
import { projectChannelTaskParts } from "../../src/channel/outbound-parts"
import type { MessageV2 } from "../../src/session/message-v2"

function message(input: { id: string; rootID: string; parts: MessageV2.Part[]; finish?: string }): MessageV2.WithParts {
  return {
    info: {
      id: input.id,
      sessionID: "session_test",
      role: "assistant",
      parentID: input.rootID,
      rootID: input.rootID,
      mode: "synergy",
      agent: "synergy",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test-provider",
      time: { created: Date.now(), completed: Date.now() },
      finish: input.finish ?? "stop",
    },
    parts: input.parts,
  }
}

function attachment(input: {
  id: string
  messageID: string
  url: string
  mime: string
  filename: string
  hidden?: boolean
  localPath?: string
  deliverable?: boolean
  detectedFrom?: "markdown" | "file_url" | "line" | "path"
}): MessageV2.AttachmentPart {
  return {
    id: input.id,
    sessionID: "session_test",
    messageID: input.messageID,
    type: "attachment",
    url: input.url,
    mime: input.mime,
    filename: input.filename,
    presentation: input.hidden ? { hidden: true } : { renderer: "image" },
    ...(input.localPath ? { localPath: input.localPath } : {}),
    ...(input.deliverable !== undefined || input.detectedFrom
      ? {
          metadata: {
            kind: "attachment",
            attachment: {
              originTool: "process",
              ...(input.detectedFrom ? { detectedFrom: input.detectedFrom } : {}),
              ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
            },
          },
        }
      : {}),
  }
}

function completedTool(input: {
  id: string
  messageID: string
  attachments: MessageV2.AttachmentPart[]
}): MessageV2.ToolPart {
  return {
    id: input.id,
    sessionID: "session_test",
    messageID: input.messageID,
    type: "tool",
    callID: `call_${input.id}`,
    tool: "generate_meme",
    state: {
      status: "completed",
      input: {},
      output: "Generated media",
      title: "Generate media",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
      attachments: input.attachments,
    },
  }
}

describe("Channel task outbound parts", () => {
  test("projects terminal text followed by tool attachments from earlier assistant steps", async () => {
    const svgID = await Asset.write(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>'),
      "image/svg+xml",
      "meme.svg",
    )
    const pngID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
    const rootID = "message_root"
    const toolMessageID = "message_tool"
    const terminalMessageID = "message_terminal"
    const svg = attachment({
      id: "attachment_svg",
      messageID: toolMessageID,
      url: `asset://${svgID}`,
      mime: "image/svg+xml",
      filename: "meme.svg",
    })
    const png = attachment({
      id: "attachment_png",
      messageID: toolMessageID,
      url: `asset://${pngID}`,
      mime: "image/png",
      filename: "preview.png",
    })
    const external = attachment({
      id: "attachment_external",
      messageID: toolMessageID,
      url: "http://127.0.0.1/internal.png",
      localPath: Asset.resolvePath(pngID),
      mime: "image/png",
      filename: "external.png",
    })
    const hidden = attachment({
      id: "attachment_hidden",
      messageID: toolMessageID,
      url: "https://example.test/internal.png",
      mime: "image/png",
      filename: "internal.png",
      hidden: true,
    })
    const messages = [
      message({
        id: toolMessageID,
        rootID,
        finish: "tool-calls",
        parts: [
          completedTool({
            id: "tool_meme",
            messageID: toolMessageID,
            attachments: [svg, png, external, hidden, svg],
          }),
        ],
      }),
      message({
        id: terminalMessageID,
        rootID,
        parts: [
          {
            id: "text_terminal",
            sessionID: "session_test",
            messageID: terminalMessageID,
            type: "text",
            text: "Meme generated",
          },
        ],
      }),
    ]

    expect(
      await projectChannelTaskParts({
        messages,
        rootID,
        terminalMessageID,
        includeText: true,
      }),
    ).toEqual([
      { type: "text", text: "Meme generated" },
      {
        type: "file",
        path: Asset.resolvePath(svgID),
        filename: "meme.svg",
        contentType: "image/svg+xml",
      },
      {
        type: "image",
        path: Asset.resolvePath(pngID),
        filename: "preview.png",
        contentType: "image/png",
      },
    ])
  })

  test("projects attachments without requiring terminal text", async () => {
    const assetID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "result.png")
    const rootID = "message_root"
    const toolMessageID = "message_tool"
    const messages = [
      message({
        id: toolMessageID,
        rootID,
        finish: "tool-calls",
        parts: [
          completedTool({
            id: "tool_image",
            messageID: toolMessageID,
            attachments: [
              attachment({
                id: "attachment_image",
                messageID: toolMessageID,
                url: `asset://${assetID}`,
                mime: "image/png",
                filename: "result.png",
              }),
            ],
          }),
        ],
      }),
    ]

    expect(
      await projectChannelTaskParts({
        messages,
        rootID,
        terminalMessageID: "message_terminal",
        includeText: false,
      }),
    ).toEqual([
      {
        type: "image",
        path: Asset.resolvePath(assetID),
        filename: "result.png",
        contentType: "image/png",
      },
    ])
  })

  test("skips asset attachments larger than the Channel delivery limit", async () => {
    const assetID = await Asset.write(Buffer.alloc(25 * 1024 * 1024 + 1), "application/octet-stream", "large.bin")
    const rootID = "message_root"
    const toolMessageID = "message_tool"

    expect(
      await projectChannelTaskParts({
        messages: [
          message({
            id: toolMessageID,
            rootID,
            finish: "tool-calls",
            parts: [
              completedTool({
                id: "tool_large_file",
                messageID: toolMessageID,
                attachments: [
                  attachment({
                    id: "attachment_large_file",
                    messageID: toolMessageID,
                    url: `asset://${assetID}`,
                    mime: "application/octet-stream",
                    filename: "large.bin",
                  }),
                ],
              }),
            ],
          }),
        ],
        rootID,
        terminalMessageID: "message_terminal",
        includeText: false,
      }),
    ).toEqual([])
  })

  test("deduplicates attachments that share the same asset url", async () => {
    const pngID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
    const rootID = "message_root"
    const toolMessageID = "message_tool"

    expect(
      await projectChannelTaskParts({
        messages: [
          message({
            id: toolMessageID,
            rootID,
            finish: "tool-calls",
            parts: [
              completedTool({
                id: "tool_dupe",
                messageID: toolMessageID,
                attachments: [
                  attachment({
                    id: "attachment_first",
                    messageID: toolMessageID,
                    url: `asset://${pngID}`,
                    mime: "image/png",
                    filename: "preview.png",
                  }),
                  attachment({
                    id: "attachment_second",
                    messageID: toolMessageID,
                    url: `asset://${pngID}`,
                    mime: "image/png",
                    filename: "preview.png",
                  }),
                ],
              }),
            ],
          }),
        ],
        rootID,
        terminalMessageID: "message_terminal",
        includeText: false,
      }),
    ).toEqual([
      {
        type: "image",
        path: Asset.resolvePath(pngID),
        filename: "preview.png",
        contentType: "image/png",
      },
    ])
  })

  test("filters attachments classified as non-deliverables", async () => {
    const pngID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
    const rootID = "message_root"
    const toolMessageID = "message_tool"

    expect(
      await projectChannelTaskParts({
        messages: [
          message({
            id: toolMessageID,
            rootID,
            finish: "tool-calls",
            parts: [
              completedTool({
                id: "tool_incidental",
                messageID: toolMessageID,
                attachments: [
                  attachment({
                    id: "attachment_incidental",
                    messageID: toolMessageID,
                    url: `asset://${pngID}`,
                    mime: "image/png",
                    filename: "preview.png",
                    deliverable: false,
                  }),
                ],
              }),
            ],
          }),
        ],
        rootID,
        terminalMessageID: "message_terminal",
        includeText: false,
      }),
    ).toEqual([])
  })

  test("filters legacy incidental attachments via the detectedFrom fallback", async () => {
    const pngID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
    const rootID = "message_root"
    const toolMessageID = "message_tool"

    expect(
      await projectChannelTaskParts({
        messages: [
          message({
            id: toolMessageID,
            rootID,
            finish: "tool-calls",
            parts: [
              completedTool({
                id: "tool_legacy_incidental",
                messageID: toolMessageID,
                attachments: [
                  attachment({
                    id: "attachment_legacy_incidental",
                    messageID: toolMessageID,
                    url: `asset://${pngID}`,
                    mime: "image/png",
                    filename: "preview.png",
                    detectedFrom: "path",
                  }),
                ],
              }),
            ],
          }),
        ],
        rootID,
        terminalMessageID: "message_terminal",
        includeText: false,
      }),
    ).toEqual([])
  })

  test("keeps attachments referenced explicitly via markdown and file urls", async () => {
    const markdownID = await Asset.write(Buffer.from([137, 80, 78, 71, 1]), "image/png", "markdown.png")
    const fileUrlID = await Asset.write(Buffer.from([137, 80, 78, 71, 2]), "image/png", "file-url.png")
    const rootID = "message_root"
    const toolMessageID = "message_tool"

    expect(
      await projectChannelTaskParts({
        messages: [
          message({
            id: toolMessageID,
            rootID,
            finish: "tool-calls",
            parts: [
              completedTool({
                id: "tool_explicit",
                messageID: toolMessageID,
                attachments: [
                  attachment({
                    id: "attachment_markdown",
                    messageID: toolMessageID,
                    url: `asset://${markdownID}`,
                    mime: "image/png",
                    filename: "markdown.png",
                    deliverable: true,
                    detectedFrom: "markdown",
                  }),
                  attachment({
                    id: "attachment_file_url",
                    messageID: toolMessageID,
                    url: `asset://${fileUrlID}`,
                    mime: "image/png",
                    filename: "file-url.png",
                    deliverable: true,
                    detectedFrom: "file_url",
                  }),
                ],
              }),
            ],
          }),
        ],
        rootID,
        terminalMessageID: "message_terminal",
        includeText: false,
      }),
    ).toEqual([
      {
        type: "image",
        path: Asset.resolvePath(markdownID),
        filename: "markdown.png",
        contentType: "image/png",
      },
      {
        type: "image",
        path: Asset.resolvePath(fileUrlID),
        filename: "file-url.png",
        contentType: "image/png",
      },
    ])
  })
})

test("skips attachments already recorded as delivered on the root message", async () => {
  const pngID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
  const rootID = "message_root"
  const toolMessageID = "message_tool"
  const rootMessage: MessageV2.WithParts = {
    info: {
      id: rootID,
      sessionID: "session_test",
      role: "user",
      isRoot: true,
      rootID,
      agent: "synergy",
      model: { providerID: "test-provider", modelID: "test-model" },
      time: { created: Date.now() },
      metadata: { channelOutboundAttachmentUrls: [`asset://${pngID}`] },
    },
    parts: [],
  }

  expect(
    await projectChannelTaskParts({
      messages: [
        rootMessage,
        message({
          id: toolMessageID,
          rootID,
          finish: "tool-calls",
          parts: [
            completedTool({
              id: "tool_delivered",
              messageID: toolMessageID,
              attachments: [
                attachment({
                  id: "attachment_delivered",
                  messageID: toolMessageID,
                  url: `asset://${pngID}`,
                  mime: "image/png",
                  filename: "preview.png",
                  deliverable: true,
                }),
              ],
            }),
          ],
        }),
      ],
      rootID,
      terminalMessageID: "message_terminal",
      includeText: false,
    }),
  ).toEqual([])
})
