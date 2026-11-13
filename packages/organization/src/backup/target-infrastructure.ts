import type { OrganizationServiceOptions } from "../service"

export type OrganizationTargetInfrastructure = Pick<OrganizationServiceOptions, "database" | "cloud">

export function captureOrganizationTargetInfrastructure(
  value: OrganizationTargetInfrastructure | undefined,
): OrganizationTargetInfrastructure {
  const database = value?.database,
    cloud = value?.cloud
  return Object.freeze({
    database: database ? Object.freeze({ ...database }) : undefined,
    cloud: cloud
      ? Object.freeze({
          blobStores:
            cloud.blobStores &&
            Object.fromEntries(
              Object.entries(cloud.blobStores).map(([id, store]) => [
                id,
                Object.freeze({ get: store.get.bind(store), put: store.put.bind(store) }),
              ]),
            ),
          workspaceProfiles: cloud.workspaceProfiles && structuredClone(cloud.workspaceProfiles),
          environmentProfiles: cloud.environmentProfiles && structuredClone(cloud.environmentProfiles),
          environmentProviders: cloud.environmentProviders?.map((provider) =>
            Object.freeze({
              id: provider.id,
              ownership: provider.ownership,
              validateSpec: provider.validateSpec?.bind(provider),
              portableDescriptor: provider.portableDescriptor?.bind(provider),
              allocate: provider.allocate.bind(provider),
              inspect: provider.inspect.bind(provider),
              resume: provider.resume?.bind(provider),
              deallocate: provider.deallocate.bind(provider),
              withDeallocation: provider.withDeallocation?.bind(provider),
              connect: provider.connect?.bind(provider),
              workspacePath: provider.workspacePath?.bind(provider),
              close: provider.close?.bind(provider),
            }),
          ),
        })
      : undefined,
  })
}
