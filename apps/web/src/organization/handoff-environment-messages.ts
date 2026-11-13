import type { MessageDescriptor } from "@lingui/core"

export const organizationHandoffEnvironmentMessages = {
  environment: { id: "organization.handoff.environment.label", message: "Command environment" },
  native: { id: "organization.handoff.environment.native", message: "Destination computer" },
  none: { id: "organization.handoff.environment.none", message: "Files only" },
  cloud: { id: "organization.handoff.environment.cloud", message: "Organization environment" },
  keep: { id: "organization.handoff.environment.keep", message: "Keep the current cloud environment" },
  chooseResource: { id: "organization.handoff.environment.chooseResource", message: "Choose an execution resource" },
  chooseEnvironment: { id: "organization.handoff.environment.chooseEnvironment", message: "Choose an environment" },
  nativeHint: {
    id: "organization.handoff.environment.nativeHint",
    message: "Use the destination computer for future commands. Running processes and credentials are not copied.",
  },
  noneHint: {
    id: "organization.handoff.environment.noneHint",
    message: "Files remain available. Commands need an environment selected separately.",
  },
  keepHint: {
    id: "organization.handoff.environment.keepHint",
    message:
      "Future commands use the same organization environment. Moving the conversation does not allocate compute or restart processes.",
  },
  incompatible: {
    id: "organization.handoff.environment.incompatible",
    message: "Choose a command environment compatible with this file location.",
  },
  empty: { id: "organization.handoff.environment.empty", message: "No environments are available in this resource." },
  refresh: { id: "organization.handoff.environment.refresh", message: "Check environments again" },
} satisfies Record<string, MessageDescriptor>
