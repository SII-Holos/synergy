import { InstructionRegistry } from "../instruction/registry"
import { CommandRenderer } from "./renderer"

/**
 * H7 command domain registration: mounts the command and mcp instruction
 * sources (engine + shell/trim policy stages) so the session loop renders
 * through the L1 registry instead of forking on the source kind. MCP
 * prompts arrive through CommandSourceProviders, registered by the L4
 * product manifest.
 */
export function registerCommandDomain() {
  const render = (input: { template: string; arguments: string }) =>
    CommandRenderer.render(input).then((rendered) => [rendered])
  InstructionRegistry.register({
    kind: "command",
    render,
    hints: () => [],
  })
  InstructionRegistry.register({
    kind: "mcp",
    render,
    hints: () => [],
  })
}
