/** Content-addressed immutable bytes. Implementations scope keys to one authority. */
export interface BlobStore {
  put(hash: string, bytes: Uint8Array): Promise<void>
  get(hash: string, maximumBytes: number): Promise<Uint8Array>
}

export interface ReclaimableBlobStore extends BlobStore {
  /** Idempotent removal of one verified hash, never a bucket or prefix sweep. */
  delete(hash: string): Promise<void>
}
