import { StoragePath } from "@/storage/path"
import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"
import { GitHubPollState, type GitHubPollState as PollState } from "./types"

export namespace GitHubPollStore {
  function lock(repository: string) {
    return `github:poll:${repository}`
  }

  export async function read(repository: string): Promise<PollState | undefined> {
    const value = await Storage.read<unknown>(StoragePath.githubPollState(repository)).catch(() => undefined)
    if (value === undefined) return
    const parsed = GitHubPollState.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  export async function write(repository: string, state: PollState) {
    using _ = await Lock.write(lock(repository))
    const parsed = GitHubPollState.parse(state)
    if (parsed.repository !== repository) throw new Error("GitHub poll state repository does not match its storage key")
    await Storage.write(StoragePath.githubPollState(repository), parsed)
  }

  export async function remove(repository: string) {
    using _ = await Lock.write(lock(repository))
    await Storage.remove(StoragePath.githubPollState(repository))
  }
}
