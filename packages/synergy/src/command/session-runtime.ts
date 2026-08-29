import { Bus } from "../bus"
import { SessionCommandRuntime } from "../session/command-runtime"
import { Command } from "./command"

/**
 * S9c source inversion: the L1 session invoke loop executes commands through
 * the SessionCommandRuntime registry instead of importing the command
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerCommandSessionRuntime() {
  SessionCommandRuntime.register({
    require: (name) => Command.require(name),
    runAction: (input) =>
      Command.runAction({
        action: input.action,
        input: input.input as Command.ActionInput,
        ...(input.command ? { command: input.command as Command.Info } : {}),
      }),
    unknownActionError: (action) => new Command.UnknownActionError({ action }),
    notFoundError: (name) => new Command.NotFoundError({ name }),
    publishExecuted: (event) => Bus.publish(Command.Event.Executed, event),
    defaultInitCommand: Command.Default.INIT,
  })
}
