import { registerLocalRuntime } from "./register"

registerLocalRuntime()
await import("@ericsanchezok/synergy-harness/session/agent-turn/runner")
