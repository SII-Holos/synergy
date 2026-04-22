import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "@/id/id"
import type { StatsWatermark, SessionDigest, DailyBucket, StatsSnapshot } from "@/stats/types"

export namespace StatsStorage {
  export async function getWatermark(): Promise<StatsWatermark | undefined> {
    try {
      return await Storage.read<StatsWatermark>(StoragePath.statsWatermark())
    } catch (e) {
      if (e instanceof Storage.NotFoundError) return undefined
      throw e
    }
  }

  export async function setWatermark(watermark: StatsWatermark): Promise<void> {
    await Storage.write(StoragePath.statsWatermark(), watermark)
  }

  export async function getDigest(sessionID: string): Promise<SessionDigest | undefined> {
    try {
      return await Storage.read<SessionDigest>(StoragePath.statsDigest(sessionID as Identifier.SessionID))
    } catch (e) {
      if (e instanceof Storage.NotFoundError) return undefined
      throw e
    }
  }

  export async function setDigest(digest: SessionDigest): Promise<void> {
    await Storage.write(StoragePath.statsDigest(digest.sessionID as Identifier.SessionID), digest)
  }

  export async function removeDigest(sessionID: string): Promise<void> {
    await Storage.remove(StoragePath.statsDigest(sessionID as Identifier.SessionID))
  }

  export async function listDigestIDs(): Promise<string[]> {
    return Storage.scan(StoragePath.statsDigestsRoot())
  }

  export async function getAllDigests(): Promise<SessionDigest[]> {
    const ids = await listDigestIDs()
    if (ids.length === 0) return []
    const keys = ids.map((id) => StoragePath.statsDigest(id as Identifier.SessionID))
    const results = await Storage.readMany<SessionDigest>(keys)
    return results.filter((d): d is SessionDigest => d !== undefined)
  }

  export async function getDailyBucket(day: string): Promise<DailyBucket | undefined> {
    try {
      return await Storage.read<DailyBucket>(StoragePath.statsDaily(day))
    } catch (e) {
      if (e instanceof Storage.NotFoundError) return undefined
      throw e
    }
  }

  export async function setDailyBucket(day: string, bucket: DailyBucket): Promise<void> {
    await Storage.write(StoragePath.statsDaily(day), bucket)
  }

  export async function listDailyKeys(): Promise<string[]> {
    return Storage.scan(StoragePath.statsDailyRoot())
  }

  export async function getSnapshot(): Promise<StatsSnapshot | undefined> {
    try {
      return await Storage.read<StatsSnapshot>(StoragePath.statsSnapshot())
    } catch (e) {
      if (e instanceof Storage.NotFoundError) return undefined
      throw e
    }
  }

  export async function setSnapshot(snapshot: StatsSnapshot): Promise<void> {
    await Storage.write(StoragePath.statsSnapshot(), snapshot)
  }
}
