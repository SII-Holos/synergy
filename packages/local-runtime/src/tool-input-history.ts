import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"

/** Selective hosts retain owned migrations without enabling native providers or product groups. */
export function registerLocalToolInputHistory() {
  Tool.registerInputHistory("local-runtime", {
    bash: { description: "workBrief" },
  })
}
