import z from "zod"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"

const Snapshot = z.object({
  projects: z.array(
    z.object({
      projectID: z.string(),
      projectName: z.string().optional(),
    }),
  ),
  updatedAt: z.number(),
})

export namespace ClarusProjectSync {
  export async function load(accountHash: string): Promise<Map<string, string | undefined>> {
    const snapshot = await Storage.read<unknown>(StoragePath.clarusProviderProjectSync(accountHash))
      .then((value) => Snapshot.parse(value))
      .catch(() => undefined)
    return new Map(snapshot?.projects.map((project) => [project.projectID, project.projectName]) ?? [])
  }

  export async function save(accountHash: string, projects: ReadonlyMap<string, string | undefined>): Promise<void> {
    await Storage.write(StoragePath.clarusProviderProjectSync(accountHash), {
      projects: Array.from(projects, ([projectID, projectName]) => ({
        projectID,
        ...(projectName === undefined ? {} : { projectName }),
      })),
      updatedAt: Date.now(),
    })
  }
}
