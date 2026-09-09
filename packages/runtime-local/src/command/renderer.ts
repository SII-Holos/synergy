import { InstructionEngine } from "@ericsanchezok/synergy-harness/instruction/engine"
export namespace CommandRenderer {
  export async function render(input: { template: string; arguments: string }) {
    return InstructionEngine.render(input)[0]!.trim()
  }
}
