import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { stream } from "hono/streaming"
import z from "zod"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { SessionInvoke, InvokeInput } from "../session/invoke"
import { shell as invokeShell, ShellInput } from "../session/shell"
import { SessionRevert } from "../session/revert"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Todo } from "../session/todo"
import { Dag } from "../session/dag"
import { Snapshot } from "../session/snapshot"
import { Agent } from "../agent/agent"
import { Instance } from "../scope/instance"
import { Log } from "../util/log"
import { errors } from "./error"

const log = Log.create({ service: "session" })

export const SessionRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List sessions",
      description: "Get a list of all Synergy sessions, sorted by most recently updated.",
      operationId: "session.list",
      responses: {
        200: {
          description: "List of sessions",
          content: {
            "application/json": {
              schema: resolver(Session.Info.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        start: z.coerce
          .number()
          .optional()
          .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
        search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
        limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      const term = query.search?.toLowerCase()
      const sessions: Session.Info[] = []
      for await (const session of Session.list()) {
        if (query.start !== undefined && session.time.updated < query.start) continue
        if (term !== undefined && !session.title.toLowerCase().includes(term)) continue
        sessions.push(session)
        if (query.limit !== undefined && sessions.length >= query.limit) break
      }
      return c.json(sessions)
    },
  )
  .get(
    "/status",
    describeRoute({
      summary: "Get session status",
      description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
      operationId: "session.status",
      responses: {
        200: {
          description: "Get session status",
          content: {
            "application/json": {
              schema: resolver(z.record(z.string(), Session.StatusInfo)),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const result = SessionManager.listStatuses(Instance.scope.id)
      return c.json(result)
    },
  )
  .get(
    "/:sessionID",
    describeRoute({
      summary: "Get session",
      description: "Retrieve detailed information about a specific Synergy session.",
      tags: ["Session"],
      operationId: "session.get",
      responses: {
        200: {
          description: "Get session",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: Session.get.schema,
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      log.info("SEARCH", { url: c.req.url })
      const session = await Session.get(sessionID)
      return c.json(session)
    },
  )
  .get(
    "/:sessionID/children",
    describeRoute({
      summary: "Get session children",
      tags: ["Session"],
      description: "Retrieve all child sessions that were forked from the specified parent session.",
      operationId: "session.children",
      responses: {
        200: {
          description: "List of children",
          content: {
            "application/json": {
              schema: resolver(Session.Info.array()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: Session.children.schema,
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const session = await Session.children(sessionID)
      return c.json(session)
    },
  )
  .get(
    "/:sessionID/todo",
    describeRoute({
      summary: "Get session todos",
      description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
      operationId: "session.todo",
      responses: {
        200: {
          description: "Todo list",
          content: {
            "application/json": {
              schema: resolver(Todo.Info.array()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const todos = await Todo.get(sessionID)
      return c.json(todos)
    },
  )
  .get(
    "/:sessionID/dag",
    describeRoute({
      summary: "Get session DAG",
      description: "Retrieve the task DAG associated with a specific session.",
      operationId: "session.dag",
      responses: {
        200: {
          description: "DAG node list",
          content: {
            "application/json": {
              schema: resolver(Dag.Node.array()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const nodes = await Dag.get(sessionID)
      return c.json(nodes)
    },
  )
  .post(
    "/",
    describeRoute({
      summary: "Create session",
      description: "Create a new Synergy session for interacting with AI assistants and managing conversations.",
      operationId: "session.create",
      responses: {
        ...errors(400),
        200: {
          description: "Successfully created session",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
      },
    }),
    validator(
      "json",
      z
        .object({
          parentID: z.string().optional(),
          title: z.string().optional(),
          id: z.string().optional(),
        })
        .optional(),
    ),
    async (c) => {
      const body = c.req.valid("json") ?? {}
      const session = await Session.create(body)
      return c.json(session)
    },
  )
  .delete(
    "/:sessionID",
    describeRoute({
      summary: "Delete session",
      description: "Delete a session and permanently remove all associated data, including messages and history.",
      operationId: "session.delete",
      responses: {
        200: {
          description: "Successfully deleted session",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: Session.remove.schema,
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      await Session.remove(sessionID)
      return c.json(true)
    },
  )
  .patch(
    "/:sessionID",
    describeRoute({
      summary: "Update session",
      description: "Update properties of an existing session, such as title or other metadata.",
      operationId: "session.update",
      responses: {
        200: {
          description: "Successfully updated session",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string(),
      }),
    ),
    validator(
      "json",
      z.object({
        title: z.string().optional(),
        pinned: z.number().optional(),
        time: z
          .object({
            archived: z.number().optional(),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const updates = c.req.valid("json")

      const updatedSession = await Session.update(sessionID, (session) => {
        if (updates.title !== undefined) session.title = updates.title
        if (updates.pinned !== undefined) session.pinned = updates.pinned
        if (updates.time?.archived !== undefined) session.time.archived = updates.time.archived
      })

      return c.json(updatedSession)
    },
  )
  .post(
    "/:sessionID/init",
    describeRoute({
      summary: "Initialize session",
      description:
        "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
      operationId: "session.init",
      responses: {
        200: {
          description: "200",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    validator("json", SessionInvoke.initialize.schema.omit({ sessionID: true })),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const body = c.req.valid("json")
      await SessionInvoke.initialize({ ...body, sessionID })
      return c.json(true)
    },
  )
  .post(
    "/:sessionID/fork",
    describeRoute({
      summary: "Fork session",
      description: "Create a new session by forking an existing session at a specific message point.",
      operationId: "session.fork",
      responses: {
        200: {
          description: "200",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: Session.fork.schema.shape.sessionID,
      }),
    ),
    validator("json", Session.fork.schema.omit({ sessionID: true })),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const body = c.req.valid("json")
      const result = await Session.fork({ ...body, sessionID })
      return c.json(result)
    },
  )
  .post(
    "/:sessionID/abort",
    describeRoute({
      summary: "Abort session",
      description: "Abort an active session and stop any ongoing AI processing or command execution.",
      operationId: "session.abort",
      responses: {
        200: {
          description: "Aborted session",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string(),
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      SessionInvoke.cancel(sessionID)
      const { Cortex } = await import("../cortex")
      await Cortex.cancelAll(sessionID)
      return c.json(true)
    },
  )

  .post(
    "/:sessionID/summarize",
    describeRoute({
      summary: "Summarize session",
      description: "Generate a concise summary of the session using AI compaction to preserve key information.",
      operationId: "session.summarize",
      responses: {
        200: {
          description: "Summarized session",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    validator(
      "json",
      z.object({
        providerID: z.string(),
        modelID: z.string(),
        auto: z.boolean().optional().default(false),
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const body = c.req.valid("json")
      const session = await Session.get(sessionID)
      await SessionRevert.cleanup(session)
      const msgs = await Session.messages({ sessionID })
      let currentAgent = await Agent.defaultAgent()
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i].info
        if (info.role === "user") {
          currentAgent = info.agent || (await Agent.defaultAgent())
          break
        }
      }
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: {
          providerID: body.providerID,
          modelID: body.modelID,
        },
        sessionID,
        agent: currentAgent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID,
        type: "compaction",
        auto: body.auto,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID,
        type: "text",
        text: "What did we do so far?",
      })
      await SessionInvoke.loop(sessionID)
      return c.json(true)
    },
  )
  .get(
    "/:sessionID/message",
    describeRoute({
      summary: "Get session messages",
      description: "Retrieve all messages in a session, including user prompts and AI responses.",
      operationId: "session.messages",
      responses: {
        200: {
          description: "List of messages",
          content: {
            "application/json": {
              schema: resolver(MessageV2.WithParts.array()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    validator(
      "query",
      z.object({
        limit: z.coerce.number().optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      const messages = await Session.messages({
        sessionID: c.req.valid("param").sessionID,
        limit: query.limit,
      })
      return c.json(messages)
    },
  )
  .get(
    "/:sessionID/diff",
    describeRoute({
      summary: "Get session diff",
      description: "Get all file changes (diffs) made during this session.",
      operationId: "session.diff",
      responses: {
        200: {
          description: "List of diffs",
          content: {
            "application/json": {
              schema: resolver(Snapshot.FileDiff.array()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    async (c) => {
      const diff = await Session.diff(c.req.valid("param").sessionID)
      return c.json(diff)
    },
  )
  .get(
    "/:sessionID/message/:messageID",
    describeRoute({
      summary: "Get message",
      description: "Retrieve a specific message from a session by its message ID.",
      operationId: "session.message",
      responses: {
        200: {
          description: "Message",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  info: MessageV2.Info,
                  parts: MessageV2.Part.array(),
                }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
        messageID: z.string().meta({ description: "Message ID" }),
      }),
    ),
    async (c) => {
      const params = c.req.valid("param")
      const message = await MessageV2.get({
        sessionID: params.sessionID,
        messageID: params.messageID,
      })
      return c.json(message)
    },
  )
  .delete(
    "/:sessionID/message/:messageID/part/:partID",
    describeRoute({
      description: "Delete a part from a message",
      operationId: "part.delete",
      responses: {
        200: {
          description: "Successfully deleted part",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
        messageID: z.string().meta({ description: "Message ID" }),
        partID: z.string().meta({ description: "Part ID" }),
      }),
    ),
    async (c) => {
      const params = c.req.valid("param")
      await Session.removePart({
        sessionID: params.sessionID,
        messageID: params.messageID,
        partID: params.partID,
      })
      return c.json(true)
    },
  )
  .patch(
    "/:sessionID/message/:messageID/part/:partID",
    describeRoute({
      description: "Update a part in a message",
      operationId: "part.update",
      responses: {
        200: {
          description: "Successfully updated part",
          content: {
            "application/json": {
              schema: resolver(MessageV2.Part),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
        messageID: z.string().meta({ description: "Message ID" }),
        partID: z.string().meta({ description: "Part ID" }),
      }),
    ),
    validator("json", MessageV2.Part),
    async (c) => {
      const params = c.req.valid("param")
      const body = c.req.valid("json")
      if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
        throw new Error(
          `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
        )
      }
      const part = await Session.updatePart(body)
      return c.json(part)
    },
  )
  .post(
    "/:sessionID/message",
    describeRoute({
      summary: "Send message",
      description: "Create and send a new message to a session, streaming the AI response.",
      operationId: "session.prompt",
      responses: {
        200: {
          description: "Created message",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  info: MessageV2.Assistant,
                  parts: MessageV2.Part.array(),
                }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    validator("json", InvokeInput.omit({ sessionID: true })),
    async (c) => {
      c.status(200)
      c.header("Content-Type", "application/json")
      return stream(c, async (stream) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionInvoke.invoke({ ...body, sessionID })
        stream.write(JSON.stringify(msg))
      })
    },
  )
  .post(
    "/:sessionID/prompt_async",
    describeRoute({
      summary: "Send async message",
      description:
        "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
      operationId: "session.prompt_async",
      responses: {
        204: {
          description: "Prompt accepted",
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    validator("json", InvokeInput.omit({ sessionID: true })),
    async (c) => {
      c.status(204)
      c.header("Content-Type", "application/json")
      return stream(c, async () => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        SessionInvoke.invoke({ ...body, sessionID })
      })
    },
  )
  .post(
    "/:sessionID/command",
    describeRoute({
      summary: "Send command",
      description: "Send a new command to a session for execution by the AI assistant.",
      operationId: "session.command",
      responses: {
        200: {
          description: "Created message",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  info: MessageV2.Assistant,
                  parts: MessageV2.Part.array(),
                }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    validator("json", SessionInvoke.CommandInput.omit({ sessionID: true })),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const body = c.req.valid("json")
      const msg = await SessionInvoke.command({ ...body, sessionID })
      return c.json(msg)
    },
  )
  .post(
    "/:sessionID/shell",
    describeRoute({
      summary: "Run shell command",
      description: "Execute a shell command within the session context and return the AI's response.",
      operationId: "session.shell",
      responses: {
        200: {
          description: "Created message",
          content: {
            "application/json": {
              schema: resolver(MessageV2.Assistant),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string().meta({ description: "Session ID" }),
      }),
    ),
    validator("json", ShellInput.omit({ sessionID: true })),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const body = c.req.valid("json")
      const msg = await invokeShell({ ...body, sessionID })
      return c.json(msg)
    },
  )
  .post(
    "/:sessionID/revert",
    describeRoute({
      summary: "Revert message",
      description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
      operationId: "session.revert",
      responses: {
        200: {
          description: "Updated session",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string(),
      }),
    ),
    validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      log.info("revert", c.req.valid("json"))
      const session = await SessionRevert.revert({
        sessionID,
        ...c.req.valid("json"),
      })
      return c.json(session)
    },
  )
  .post(
    "/:sessionID/unrevert",
    describeRoute({
      summary: "Restore reverted messages",
      description: "Restore all previously reverted messages in a session.",
      operationId: "session.unrevert",
      responses: {
        200: {
          description: "Updated session",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string(),
      }),
    ),
    async (c) => {
      const sessionID = c.req.valid("param").sessionID
      const session = await SessionRevert.unrevert({ sessionID })
      return c.json(session)
    },
  )
