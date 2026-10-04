import { useParams } from "@solidjs/router"
import { usePrompt, type UploadedAttachmentPart } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { uploadPromptAttachment } from "@/utils/prompt-attachment"
import { createBrowserCommandId } from "./browser-command"

export function useBrowserDraft(sessionID: string | undefined | (() => string | undefined)) {
  const params = useParams()
  const prompt = usePrompt(),
    sdk = useSDK()
  function captureTarget() {
    const target = typeof sessionID === "function" ? sessionID() : sessionID
    if (params.id !== target) throw new Error("Return to the original conversation before adding this result.")
    const capture = prompt.capture()
    const client = sdk.client
    if (!capture.draft.ready()) {
      capture.release()
      throw new Error("Wait for the conversation draft to load, then retry.")
    }
    async function append(load: () => Promise<Omit<UploadedAttachmentPart, "type" | "id"> | undefined>, text = "") {
      if (!capture.isCurrent())
        throw new Error("The conversation changed. Return to the original task and add it again.")
      const file = await load()
      if (!capture.isCurrent())
        throw new Error("The conversation changed. Return to the original task and add it again.")
      const parts = [...capture.draft.current()]
      if (text) {
        const start = parts.reduce((end, part) => ("end" in part ? Math.max(end, part.end) : end), 0)
        parts.push({
          type: "text",
          content: (start ? "\n\n" : "") + text,
          start,
          end: start + text.length + (start ? 2 : 0),
        })
      }
      if (file) parts.push({ ...file, type: "attachment", id: createBrowserCommandId() })
      capture.draft.set(parts)
    }
    return {
      isCurrent: capture.isCurrent,
      release: capture.release,
      attach: (file: File, text = "") =>
        append(async () => ({ ...(await uploadPromptAttachment(client, file)), filename: file.name }), text),
      artifact: (load: () => Promise<Omit<UploadedAttachmentPart, "type" | "id">>) => append(load),
      text: (text: string) => append(async () => undefined, text),
    }
  }
  async function append(operation: (target: ReturnType<typeof captureTarget>) => Promise<void>) {
    const target = captureTarget()
    try {
      await operation(target)
    } finally {
      target.release()
    }
  }
  return {
    capture: captureTarget,
    attach: (file: File, text = "") => append((target) => target.attach(file, text)),
    artifact: (load: () => Promise<Omit<UploadedAttachmentPart, "type" | "id">>) =>
      append((target) => target.artifact(load)),
    text: (text: string) => append((target) => target.text(text)),
  }
}
