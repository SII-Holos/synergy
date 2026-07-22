import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { createTuiApp } from "./app.js"
import { createTuiController } from "./controller.js"
import { normalizeTuiOptions, type TuiOptionsInput } from "./options.js"
import { createSdkRuntimeAdapter } from "./sdk-adapter.js"

const SIGNAL_EXIT_CODE = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const

type TuiSignal = keyof typeof SIGNAL_EXIT_CODE

export async function runTui(input: TuiOptionsInput = {}) {
  const options = normalizeTuiOptions(input)
  const client = createSynergyClient({
    baseUrl: options.baseUrl,
    directory: options.directory,
    scopeID: options.scopeID,
  })
  const controller = createTuiController(createSdkRuntimeAdapter(client), { sessionID: options.sessionID })
  const app = await createTuiApp(controller, { theme: options.theme })
  const signals = Object.keys(SIGNAL_EXIT_CODE) as TuiSignal[]

  const stop = () => app.stop()
  const signalHandlers = new Map<TuiSignal, () => void>()
  for (const signal of signals) {
    const handler = () => {
      process.exitCode = SIGNAL_EXIT_CODE[signal]
      app.stop()
    }
    signalHandlers.set(signal, handler)
    process.once(signal, handler)
  }
  process.once("uncaughtExceptionMonitor", stop)
  process.once("unhandledRejection", stop)

  try {
    await app.start()
    await app.done
  } finally {
    app.stop()
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    process.off("uncaughtExceptionMonitor", stop)
    process.off("unhandledRejection", stop)
  }
}
