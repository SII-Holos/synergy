export namespace AttachmentTextExtraction {
  export interface Provider {
    supported(filepath: string): boolean
    extractText(filepath: string): Promise<string>
  }

  let provider: Provider | undefined

  export function register(value: Provider) {
    provider = value
  }

  export function supported(filepath: string) {
    return provider?.supported(filepath) ?? false
  }

  export async function extractText(filepath: string): Promise<string> {
    if (!provider) throw new Error("Document text extraction is unavailable: no processor is registered")
    return provider.extractText(filepath)
  }
}
