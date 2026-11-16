import { createContext, onCleanup, useContext, type ParentProps } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { createSessionDecisionState, type SessionDecisionState } from "./session-decision-state"
export { createSessionDecisionState, type DecisionRuntime, type SessionDecisionState } from "./session-decision-state"

const Context = createContext<SessionDecisionState>()

export function SessionDecisionProvider(props: ParentProps<{ value?: SessionDecisionState }>) {
  const value =
    props.value ??
    (() => {
      const sdk = useSDK()
      const sync = useGlobalSync()
      const state = createSessionDecisionState({
        connectionKey: sdk.cacheKey,
        scopeID: sdk.scopeID,
        questions: () => Object.values(sync.questions).flat(),
        permissions: () => Object.values(sync.permissions).flat(),
        questionSnapshot: () => sync.questionSnapshot(sdk.scopeID),
        replyQuestion: (request, answers) =>
          answers
            ? sdk.client.question.reply({ requestID: request.id, answers }, { throwOnError: true })
            : sdk.client.question.reject({ requestID: request.id }, { throwOnError: true }),
        replyPermission: (request, reply) =>
          sdk.client.permission.reply({ requestID: request.id, reply }, { throwOnError: true }),
        async questionPending(request) {
          const token = sync.captureQuestionSnapshot(sdk.scopeID)
          const result = await sdk.client.question.list(undefined, { throwOnError: true })
          if (!result.data || !sync.seedGlobalQuestions(result.data, result.response?.headers, token))
            throw new Error("Pending question could not be confirmed")
          return Object.values(sync.questions)
            .flat()
            .some((item) => item.id === request.id && item.sessionID === request.sessionID)
        },
        async permissionPending(request) {
          const result = await sdk.client.permission.list({ sessionID: request.sessionID }, { throwOnError: true })
          if (!result.data) throw new Error("Pending permission could not be confirmed")
          sync.seedSessionPermissions(request.sessionID, result.data, result.response?.headers, sdk.scopeID)
          return (sync.permissions[request.sessionID] ?? []).some(
            (item) => item.id === request.id && item.sessionID === request.sessionID,
          )
        },
      })
      const releases = [
        sdk.event.on("question.replied", (event) =>
          state.ended("question", event.properties.sessionID, event.properties.requestID),
        ),
        sdk.event.on("question.rejected", (event) =>
          state.ended("question", event.properties.sessionID, event.properties.requestID),
        ),
        sdk.event.on("question.timed_out", (event) =>
          state.ended("question", event.properties.sessionID, event.properties.requestID),
        ),
        sdk.event.on("permission.replied", (event) =>
          state.ended("permission", event.properties.sessionID, event.properties.requestID),
        ),
      ]
      onCleanup(() => releases.forEach((release) => release()))
      return state
    })()
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useSessionDecision() {
  const value = useContext(Context)
  if (!value) throw new Error("SessionDecisionProvider is required")
  return value
}
