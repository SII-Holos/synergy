import { RuntimeContext } from "../lifecycle/context"
export namespace AttachmentTextExtraction {
  export interface Provider {
    supported(filepath: string): boolean
    extractText(filepath: string): Promise<string>
  }

  const runtimeState = RuntimeContext.state(() => ({
    provider: undefined as Provider | undefined,
  }))

  export function register(value: Provider) {
    const instanceState = runtimeState()

    if (instanceState.provider === value) return
    RuntimeContext.assertCompositionOpen("attachment/text-extraction")
    if (instanceState.provider && value) throw new Error("attachment/text-extraction is already registered")
    instanceState.provider = value
  }

  export function supported(filepath: string) {
    const instanceState = runtimeState()

    return instanceState.provider?.supported(filepath) ?? false
  }

  export async function extractText(filepath: string): Promise<string> {
    const instanceState = runtimeState()

    if (!instanceState.provider) throw new Error("Document text extraction is unavailable: no processor is registered")
    return instanceState.provider.extractText(filepath)
  }
}
