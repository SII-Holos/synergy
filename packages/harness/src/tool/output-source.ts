import { RuntimeContext } from "../lifecycle/context"
import { z } from "zod"

export namespace ToolOutputSource {
  export interface Origin {
    sessionID: string
    messageID: string
    callID?: string
  }
  export interface Input {
    id: string
    text: string
    origin?: Origin
  }
  export interface Source {
    save(input: Readonly<Input>): Promise<string>
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))
  const reference = z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\r\n\0]/.test(value))
  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("tool output source")
    if (state().source) throw new Error("Tool output source is already registered")
    state().source = source
  }
  export function get() {
    return state().source
  }
  export async function save(source: Source, input: Input) {
    return reference.parse(await source.save(Object.freeze(structuredClone(input))))
  }
}
