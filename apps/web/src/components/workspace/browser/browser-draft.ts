import { useParams } from "@solidjs/router"
import { usePrompt, type UploadedAttachmentPart } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { uploadPromptAttachment } from "@/utils/prompt-attachment"
import { createBrowserCommandId } from "./browser-command"

export function useBrowserDraft(sessionID: string) {
  const params = useParams()
  const prompt = usePrompt(),
    sdk = useSDK()
  async function append(load: () => Promise<Omit<UploadedAttachmentPart, "type" | "id"> | undefined>, text = "") {
    if (params.id !== sessionID) throw new Error("Return to the original conversation before adding this result.")
    const capture = prompt.capture()
    try {
      if (!capture.draft.ready()) throw new Error("Wait for the conversation draft to load, then retry.")
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
    } finally {
      capture.release()
    }
  }
  return {
    attach: (file: File, text = "") =>
      append(async () => ({ ...(await uploadPromptAttachment(sdk.client, file)), filename: file.name }), text),
    artifact: (load: () => Promise<Omit<UploadedAttachmentPart, "type" | "id">>) => append(load),
    text: (text: string) => append(async () => undefined, text),
  }
}
