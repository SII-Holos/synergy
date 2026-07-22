import { describe, expect, test } from "bun:test"
import { CLASSIFIER_LABEL_DESC, TOOL_TITLE_DESC } from "../../src/components/tool-title-descriptors"

describe("first-party tool title copy", () => {
  test("uses action phrases instead of bare tool categories", () => {
    const expected = new Map([
      [CLASSIFIER_LABEL_DESC.shell, "Execute command"],
      [CLASSIFIER_LABEL_DESC.web, "Access web"],
      [CLASSIFIER_LABEL_DESC.browser, "Control browser"],
      [CLASSIFIER_LABEL_DESC.session, "Manage sessions"],
      [CLASSIFIER_LABEL_DESC.blueprint, "Manage Blueprints"],
      [TOOL_TITLE_DESC.bash, "Execute command"],
      [TOOL_TITLE_DESC.webfetch, "Read web page"],
      [TOOL_TITLE_DESC.websearch, "Search web"],
      [TOOL_TITLE_DESC.session_list, "View sessions"],
      [TOOL_TITLE_DESC.scope_list, "View Scopes"],
      [TOOL_TITLE_DESC.blueprints, "View Blueprints"],
      [TOOL_TITLE_DESC.task, "Call subagent"],
      [TOOL_TITLE_DESC.task_cancel, "Cancel task"],
      [TOOL_TITLE_DESC.write, "Write file"],
    ])

    for (const [descriptor, message] of expected) expect(descriptor.message).toBe(message)
  })
})
