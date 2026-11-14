import path from "node:path"
const source = path.resolve(import.meta.dir, "../../src")
export const organizationDataFixtureSource = `
import * as outbox from ${JSON.stringify(`/@fs/${path.join(source, "organization/decision-outbox.ts")}`)}
import * as questionDrafts from ${JSON.stringify(`/@fs/${path.join(source, "organization/question-drafts.ts")}`)}
import {createOrganizationInteractionRuntime} from ${JSON.stringify(`/@fs/${path.join(source, "organization/interaction-runtime.ts")}`)}
import {createOrganizationConnections} from ${JSON.stringify(`/@fs/${path.join(source, "organization/connections.ts")}`)}
import {createOrganizationClient} from "@ericsanchezok/synergy-sdk/organization"
import {createRoot} from "solid-js"
window.decisionOutboxFixture=outbox
window.decisionDraftFixture=questionDrafts
window.questionDraftFixture=questionDrafts
window.decisionRuntimeFixture={createOrganizationInteractionRuntime,createOrganizationClient,createRoot,createOrganizationConnections}
Date.now=()=>1
`
