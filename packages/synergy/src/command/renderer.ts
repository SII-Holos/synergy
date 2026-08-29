import { InstructionEngine } from "../instruction/engine"
export namespace CommandRenderer {
  export async function render(input: { template: string; arguments: string }) {
    return InstructionEngine.render(input)[0]!.trim()
  }
}
