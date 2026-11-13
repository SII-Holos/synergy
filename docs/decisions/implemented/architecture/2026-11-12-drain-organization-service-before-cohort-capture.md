# Decision Record: Drain organization service operations before cohort capture

Status: implemented

## Problem

The independent organization service uses a raw Runtime context and dedicated SQL namespace rather than an Agent Runtime preset. Waiting only for HTTP handlers to return omits streamed gateway receipts and machine responses. Blocking every new socket message also prevents an already dispatched command from finishing, while admitting a whole connection would permit new writes during capture.

## Decision

The service registers one native `organization-service` contribution with the existing Runtime maintenance owner before migrations and composition sealing. Each HTTP or machine operation obtains a private admission receipt after the maintenance check in its SQL writer. The receipt binds its original Runtime and primary Store and remains active until the accepted operation and explicitly retained completions settle. A caller cannot copy a receipt or reuse it after closure. Each top-level, nested and retained-tail callback also has its own open frame; an ended callback cannot borrow another open tail's operation lifetime to write or mint new completion authority. The primary namespace mutation guard rejects new unadmitted writes while maintenance is held. Private temporary Stores used by canonical archive owners remain separate namespaces and cannot acquire service admission.

Each pending command exchange retains its originating operation. Only a matching validated pending response resumes that receipt during maintenance; unrelated frames use fresh admission. Incoming frames join the real service operation set before waiting behind the socket's preceding frame. Gateway invocations retain the same receipt through the response stream, cancellation and final metadata commit. Their native completion releases it even when publication fails. Maintenance drainage waits the actual receipt set, and inspection reports outstanding accepted work. Failed or cancelled drainage cannot release the hold while operations remain active.

The native service object exposes a trusted maintenance runner into its own original Runtime. This runner is tracked by shutdown but does not mint a business admission receipt. Ordinary HTTP and machine routes cannot obtain it. Startup retains the existing durable maintenance state; cold held history blocks new admissions and cannot reuse an earlier Runtime's opaque lease. This selects no Agent loops or personal configuration.

The private cohort capture helper resolves every hosted registration from the actual service namespace, validates each independent namespace's native writer, begins purpose-bound holds, drains and freezes each selected owner, then rechecks the complete service roster under those holds. Each namespace exports its canonical encrypted records and independently verified physical Snapshot segment through the existing owners. One outer encrypted recovery container seals the resulting files. A roster change or missing participant prevents publication; failed release retains its native hold and error.

Hosted identity comes from the actual Runtime composition's opaque native namespace evidence, backed by its owning Home/enrollment readers. A caller cannot supply another registration as the namespace's identity. See [namespace provenance](2026-11-12-bind-backup-namespaces-to-owning-enrollment-readers.md).

The helper reports `namespaceCheckpointsComplete`, not deployment recovery completion. Hosted credentials and non-Snapshot native files, external Workspace/Environment data, retained unpublished object state, new-incarnation publication, token revocation, current ACL reconciliation and unique old-writer fencing require their own verified segments and restore owners. Existing Workspace/Environment rows without those segments block this helper. The archive has no ordinary account download or restore route.

## Alternatives considered

**Use HTTP promise counts or close the connections.** HTTP completion precedes stream finalization, and closing a socket turns pending native responses into uncertainty instead of proving their effects absent.

**Allow all machine messages during drainage.** Authentication of a connection does not authorize a new heartbeat, sync publication or unrelated receipt after maintenance admission closes.

**Treat an archive manifest as a complete deployment backup.** Native credentials, resource bytes and writer ownership have independent lifetimes. A namespace/Snapshot seal does not supply those missing proofs or permit execution.

## Consequences

Accepted service requests can finish without reopening admission, and the freeze receipt follows their real canonical tail writes. An unread gateway stream retains its owner until finite native timeout or cancellation. A trusted raw Store owner must still await its direct calls before closing; this service contribution does not authorize arbitrary low-level Store writes. Restored execution remains blocked pending independent reconciliation.

## Verification

Organization `test/service-maintenance.test.ts` uses a real service Home, SQLite, an HTTP request-body barrier, actual machine WebSockets, native command transport, a real model upstream and streamed usage finalization. It verifies fresh HTTP/machine/native write rejection, exact accepted receipts, escaped completion refusal, rollback, cancelled drainage and retained failed release. `test/backup/cohort.test.ts` verifies independent Runtime namespaces, a real service/hosted registration roster, accepted canonical tails, binary bytes and physical Git Snapshot restoration, missing participants, roster mutation and unknown resource-owner refusal. These are focused primitive/integration checks and do not establish complete deployment restore.

The separate [installed deployment gate](../../../../script/organization-deployment-install-check.ts), selected by [deployment CI](../../../../.github/workflows/organization-deployment.yml), requires the same packed Service/CLI/Hosted closure to resolve only public exports in an installation outside the checkout. Its [fixture](../../../../test/package/fixture/organization-deployment.ts) composes actual TLS enrollment and bridge drainage, a recovery-held H0 Service installation, fixed current H1 and Hosted native/Snapshot checkpoints, original Source retirement, current-policy reconstruction and fresh Service/Hosted publication. It then requires cold ordinary readiness, the retained Hosted identity and exact binary reads. Namespace completion alone remains insufficient; all installation, writer, H0/H1 and publication proofs still come from their existing owners. This gate does not expand accepted policy/history deltas, external-resource portability or automatic Continue.
