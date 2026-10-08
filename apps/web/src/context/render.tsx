import { z } from "zod"
import { createEffect, createSignal, onCleanup, untrack, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { RenderProvider, RenderStateConflict, type RenderHost } from "@ericsanchezok/synergy-ui/context/render"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useSDK } from "./sdk"
import { Identifier } from "@/utils/id"

const C = {
  confirm: { id: "app.render.confirm", message: "Send a request about this visual" },
  description: {
    id: "app.render.confirmDescription",
    message: "Review the visual's request before sending it to this conversation. Your composer draft is preserved.",
  },
  send: { id: "app.render.send", message: "Send request" },
  sending: { id: "app.render.sending", message: "Sending…" },
  text: { id: "app.render.requestText", message: "Request" },
  stale: { id: "app.render.stale", message: "The conversation changed. Reopen the visual before sending." },
  failed: { id: "app.render.sendFailed", message: "The visual request could not be sent." },
  busy: { id: "app.render.pending", message: "Review the open visual request first." },
}
export function SessionRenderProvider(props: ParentProps) {
  const sdk = useSDK(),
    params = useParams(),
    dialog = useDialog(),
    { _ } = useLingui()
  const owner = () => JSON.stringify([sdk.url, sdk.scopeKey, params.id])
  const requests = new Map<string, Promise<"sent" | "cancelled">>()
  let confirmation: string | undefined
  function close() {
    if (confirmation) dialog.close(confirmation)
    confirmation = undefined
  }
  createEffect(() => {
    owner()
    untrack(close)
    requests.clear()
  })
  onCleanup(close)
  const host: RenderHost = {
    async read(target, signal) {
      const result = await sdk.client.render.get(target, { signal, throwOnError: true })
      return RenderArtifact.Snapshot.parse(result.data)
    },
    async write(target, input) {
      const captured = owner()
      if (target.sessionID !== params.id) throw new Error(_(C.stale))
      try {
        const result = await sdk.client.render.update({ ...target, renderStateWrite: input }, { throwOnError: true })
        if (owner() !== captured) throw new Error(_(C.stale))
        return RenderArtifact.State.parse(result.data)
      } catch (error) {
        const failure = z
          .object({ name: z.string(), data: z.object({ message: z.string(), state: RenderArtifact.State.optional() }) })
          .safeParse(error)
        if (failure.success) {
          if (failure.data.name === "RenderConflict" && failure.data.data.state)
            throw new RenderStateConflict(failure.data.data.message, failure.data.data.state)
          throw new Error(failure.data.data.message)
        }
        throw error
      }
    },
    followUp(target, source, request) {
      const input = RenderArtifact.FollowUp.parse(request)
      const key = `${target.sessionID}:${target.partID}:${input.requestID}`
      const previous = requests.get(key)
      if (previous) return previous
      if (confirmation) return Promise.reject(new Error(_(C.busy)))
      const captured = owner(),
        client = sdk.client
      if (target.sessionID !== params.id) return Promise.reject(new Error(_(C.stale)))
      const result = new Promise<"sent" | "cancelled">((resolve) => {
        let sent = false
        const id = Identifier.ascending("message")
        const abort = new AbortController()
        const confirmationID = dialog.push(
          () => {
            const [text, setText] = createSignal(input.text)
            const [busy, setBusy] = createSignal(false)
            const [error, setError] = createSignal<string>()
            let submitted: string | undefined
            return (
              <Dialog
                title={_(C.confirm)}
                description={_(C.description)}
                size="form"
                footer={
                  <Button
                    disabled={busy() || !text().trim()}
                    onClick={async () => {
                      if (owner() !== captured || target.sessionID !== params.id) {
                        setError(_(C.stale))
                        return
                      }
                      setBusy(true)
                      setError(undefined)
                      try {
                        await client.render.get(target, { throwOnError: true, signal: abort.signal })
                        if (owner() !== captured) throw new Error(_(C.stale))
                        submitted ??= `[Visual ${source.id}]\n${text().trim()}`
                        const accepted = await client.session.input(
                          {
                            sessionID: target.sessionID,
                            messageID: id,
                            parts: [{ type: "text", text: submitted }],
                            metadata: { visual: { id: source.id, messageID: target.messageID, partID: target.partID } },
                          },
                          { throwOnError: true },
                        )
                        if (!accepted.data) throw new Error(_(C.failed))
                        sent = true
                        dialog.close(confirmationID)
                      } catch (failure) {
                        setError(failure instanceof Error ? failure.message : String(failure))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    {_(busy() ? C.sending : C.send)}
                  </Button>
                }
              >
                <div data-component="render-confirm">
                  <p>{source.title}</p>
                  <textarea
                    aria-label={_(C.text)}
                    value={text()}
                    maxLength={8000}
                    disabled={busy() || !!submitted}
                    onInput={(event) => setText(event.currentTarget.value)}
                    rows={9}
                  />
                  <p role="alert">{error()}</p>
                </div>
              </Dialog>
            )
          },
          () => {
            abort.abort()
            if (confirmation === confirmationID) confirmation = undefined
            resolve(sent ? "sent" : "cancelled")
          },
          { protected: true },
        )
        confirmation = confirmationID
      })
      requests.set(key, result)
      if (requests.size > 32) requests.delete(requests.keys().next().value!)
      return result
    },
  }
  return <RenderProvider value={host}>{props.children}</RenderProvider>
}
