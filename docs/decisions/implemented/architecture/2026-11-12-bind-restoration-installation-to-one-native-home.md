# Decision Record: Bind restoration installation to one native Home

Status: implemented

## Problem

Deployment recovery prepares several independently owned records and files. A crash between their publication steps must not make the target look like a fresh installation, generate another deployment identity, or let a retry select a different database under the same Home. Installed writer ownership and a matching path string alone do not bind the target to its physical directories, primary namespace and artifact configuration.

## Decision

Harness owns one native installation intent through `lifecycle/home-restoration`. Organization-service and Hosted recovery coordinators share this primitive instead of defining separate Home-installation ledgers. The native owner obtains target paths from the actual Runtime and verifies its installed `ServerProcessLock` evidence. The intent retains the canonical Home/root device and inode, a fingerprint of the actual database configuration and physical SQLite file where applicable, and the selected artifact location. Existing local artifact directories retain their actual device/inode. A missing directory retains its canonical future address and the nearest existing native parent's identity, which verification continues to use after preparation creates that directory. Caller payloads and proposed source identity contribute immutable request hashes; they are not authorization or archive-verification evidence.

The first durable write generates an installation ID and fresh incarnation once. Retries and cold reopening retain them and reject changed request content, native target identity or database selection. A first installation requires an unowned Home and an empty canonical namespace, inspecting actual entries under the Store's writer admission rather than database file size. Temporary canonical admission closes only while this empty-target check settles; rejecting an existing nonempty target restores its ordinary write admission. Once native intent publication begins, the durable identity and recovery hold survive an unknown acknowledgement; retry does not delete the target or mint another identity.

The owning composition explicitly registers the canonical write guard before sealing, independently of when its primary Store is attached. Admission and startup assertions never register late guards. Installation uses an exclusive native file lease and callback-only opaque permits. Permits bind the original Runtime, primary Store, concrete artifact configuration and native writer. Async verification rechecks the physical target and exact persisted intent. Ordinary canonical Storage writes are blocked while installation is pending; only an open installation callback can perform its owning preparation. Closed, copied and foreign callbacks cannot retain that authority. Publication callers still carry the native permit assertion to their actual SQL commit guard. Ordinary startup has an explicit reader assertion that refuses an unfinished intent. Public inspection omits native paths and payload bodies.

The primitive currently retains `staging` and never certifies readable or executable recovery. Object-backed artifact targets require their owning reconstruction port and are rejected here until that actual address evidence exists; a shared writer label or directory cannot distinguish two Blob authorities. Domain owners must verify the fixed archive, publish their own installation receipts, create the active service signer, invalidate old authority and reconcile current authorization and old physical writers before a later recovery finalizer can open those boundaries. No runtime, Agent, Inbox or outbox is started by this owner.

## Alternatives considered

**Separate service and Hosted installation intents.** Both would need to enforce the same native identity, cancellation and retry rules, creating different authorities for one recovery lifecycle.

**Regenerate identity on every retry.** A response can disappear after the native file is durable. A new incarnation would split one partially installed target into incompatible logical deployments.

**Treat directory equality or a new process lock as full recovery evidence.** The same path can contain another directory or database. A target's local writer cannot prove that an old offline Runtime stopped or that authorization did not change after the checkpoint.

## Consequences

Native restoration now has a durable, inspectable installation boundary without loading application authority. It requires the original empty target or an exact matching intent, and a restricted owning callback for preparation. This is a foundation for deployment recovery, not completion of PR20 or proof that imported Sessions can Continue. Low-level raw Store users retain their existing ownership obligation; the guard protects canonical Storage entrypoints and does not turn arbitrary Store access into an application authorization surface.

## Verification

`packages/harness/test/lifecycle/home-restoration.test.ts` uses real temporary Homes, installed process locks and independently reopened SQLite Stores. It covers a successful native write whose acknowledgement is lost, cold retry preserving the first identity, changed requests, different databases under the same Home, foreign/expired/forged callbacks, artifact drift and physical directory replacement. Two distinct filesystem Blob implementations with the same writer label exercise the reconstruction requirement across a cold Runtime; replacing an existing local artifact directory also rejects. Other cases cover nonempty target rejection with continued ordinary writes, sealed composition before Store attachment, actual native lock contention followed by cancellation and ordinary canonical writes. All fixtures avoid application services and Agent execution.
