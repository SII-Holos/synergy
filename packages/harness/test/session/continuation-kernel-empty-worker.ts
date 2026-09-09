import { Log } from "../../src/util/log"
import { ContinuationKernel } from "../../src/session/continuation-kernel"

/**
 * Empty-registry signature worker (criterion 5): spawned as a bare `bun run`
 * process by continuation-kernel.test.ts so the module registry starts
 * genuinely empty — the parent test file imports product-registration at the
 * top, which would register the four domain policy providers in-process.
 * Prints the propose() result on stdout; the "no policies registered" warn
 * goes to stderr via Log.init({ print: true }).
 */

await Log.init({ print: true })
const result = await ContinuationKernel.propose("ses_does_not_exist")
console.log(`PROPOSE_RESULT:${result === undefined ? "undefined" : JSON.stringify(result)}`)
