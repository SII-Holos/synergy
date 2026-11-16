import { z } from "zod"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"

export const OrganizationInstallationReference = z.strictObject({
  installationID: z.uuid(),
  incarnation: z.uuid(),
  restoreID: HomeRestoration.Request.shape.restoreID,
  requestHash: OrganizationProtocol.Digest,
  sourceHash: OrganizationProtocol.Digest,
  nativeHash: OrganizationProtocol.Digest,
})
