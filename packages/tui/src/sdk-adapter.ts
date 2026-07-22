import type {
  EventReplayResult,
  QuestionAnswer,
  SessionInputResult,
  SessionMessagePage,
  SynergyClientInstance,
} from "@ericsanchezok/synergy-sdk/client"
import type { MessagePageResult, RuntimeAdapter, SessionUpdate } from "./controller.js"

export type SdkRuntimeAdapterOptions = {
  messagePageSize?: number
  requestTimeoutMs?: number
}

const DEFAULT_MESSAGE_PAGE_SIZE = 50
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function watermark(headers: Headers) {
  const epoch = headers.get("x-synergy-epoch") ?? undefined
  const rawSeq = headers.get("x-synergy-seq")
  const parsedSeq = rawSeq === null ? undefined : Number.parseInt(rawSeq, 10)
  const seq = parsedSeq !== undefined && Number.isSafeInteger(parsedSeq) && parsedSeq >= 0 ? parsedSeq : undefined
  return { epoch, seq }
}

function isCursorError(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false
  const name = error.name
  return name === "SessionMessagePageCursorInvalidError" || name === "SessionMessagePageCursorStaleError"
}

export function createSdkRuntimeAdapter(
  client: SynergyClientInstance,
  options: SdkRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const messagePageSize = options.messagePageSize ?? DEFAULT_MESSAGE_PAGE_SIZE
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const requestOptions = () => ({
    throwOnError: true as const,
    signal: AbortSignal.timeout(requestTimeoutMs),
  })

  const fetchMessagePage = async (sessionID: string, cursor?: string): Promise<SessionMessagePage> => {
    const result = await client.session.messagePage({ sessionID, cursor, limit: messagePageSize }, requestOptions())
    return result.data
  }

  return {
    async health() {
      const result = await client.global.health(requestOptions())
      return result.data
    },
    async bootstrap() {
      const result = await client.scope.bootstrap({}, requestOptions())
      return { data: result.data, ...watermark(result.response.headers) }
    },
    async listInteractions() {
      const [permissions, questions] = await Promise.all([
        client.permission.list({}, requestOptions()),
        client.question.list({}, requestOptions()),
      ])
      return { permissions: permissions.data, questions: questions.data }
    },
    async subscribe(signal, lifecycle) {
      const result = await client.event.subscribe(
        { stream: "delta" },
        {
          signal,
          onSseError() {
            lifecycle?.onDisconnect()
          },
        },
      )
      return result.stream
    },
    async replay(since, epoch) {
      const result = await client.event.replay({ since, epoch }, requestOptions())
      return result.data as EventReplayResult
    },
    async messagePage(sessionID, cursor): Promise<MessagePageResult> {
      try {
        return await fetchMessagePage(sessionID, cursor)
      } catch (error) {
        if (!cursor || !isCursorError(error)) throw error
        return { ...(await fetchMessagePage(sessionID)), reset: true }
      }
    },
    async sessionResources(sessionID) {
      const [todos, dag] = await Promise.all([
        client.session.todo({ sessionID }, requestOptions()),
        client.session.dag({ sessionID }, requestOptions()),
      ])
      return { todos: todos.data, dag: dag.data }
    },
    async getSession(sessionID) {
      const result = await client.session.get({ sessionID }, requestOptions())
      return result.data
    },
    async createSession(title) {
      const result = await client.session.create({ title }, requestOptions())
      return result.data
    },
    async updateSession(sessionID, patch: SessionUpdate) {
      const result = await client.session.update(
        {
          sessionID,
          title: patch.title,
          pinned: patch.pinned,
          ...(patch.archived === undefined ? {} : { time: { archived: patch.archived } }),
        },
        requestOptions(),
      )
      return result.data
    },
    async deleteSession(sessionID) {
      await client.session.delete({ sessionID }, requestOptions())
    },
    async sendInput(sessionID, text): Promise<SessionInputResult> {
      const result = await client.session.input({ sessionID, parts: [{ type: "text", text }] }, requestOptions())
      return result.data
    },
    async sendCommand(sessionID, command, args) {
      await client.session.command({ sessionID, command, arguments: args ?? "" }, requestOptions())
    },
    async abortSession(sessionID) {
      await client.session.abort({ sessionID }, requestOptions())
    },
    async replyPermission(requestID, reply, message) {
      await client.permission.reply({ requestID, reply, message }, requestOptions())
    },
    async replyQuestion(requestID, answers: QuestionAnswer[]) {
      await client.question.reply({ requestID, answers }, requestOptions())
    },
    async rejectQuestion(requestID) {
      await client.question.reject({ requestID }, requestOptions())
    },
  }
}
