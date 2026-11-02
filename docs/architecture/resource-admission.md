# Runtime resource admission

Harness owns resource policy in `resources`; Local Runtime owns native observations. `ResourceHost` registers before Runtime startup. Sampling starts before session admission, independently of Observability, and remains available through execution cleanup. Native handles and timers close with their Runtime.

The snapshot distinguishes physical availability, Linux ancestor cgroup headroom, Windows commit capacity and Job or process constraints. Linux `memory.high` indicates throttling rather than hard capacity. Darwin uses native memory pressure and VM statistics; speculative pages are already included in free pages. Missing essential measurements block new allocation. Missing optional pressure detail is reported as partial coverage.

The admission ledger subtracts safety reserve and outstanding future commitments from every domain's available capacity. Requests reserve synchronously and atomically. Root owners rotate fairly. A named execution ceiling and a memory commitment are acquired together for model execution. A stage checkpoint consumes future allocation only after a later sample. Owners release after completed allocation has been sampled or after the stream/process has actually stopped. Yielding a Cortex or tool slot does not claim to release RAM.

Sampling uses five seconds at idle and one second with pressure or waiting work. Native Darwin and Windows notifications are checked without blocking every 250 milliseconds. Samples older than three expected intervals block admission. Warning pressure admits at most one allocation per fresh sample. Critical pressure admits none. Ten healthy seconds enter recovery; five fresh recovery samples and a successfully completed probe restore normal admission. Timers wake an empty execution pool without needing a task completion.

Temporary shortage remains cancellable waiting work. There is no new resource-wait deadline or model retry. A declared minimum above a hard capacity can fail permanently; an estimate alone cannot prove impossibility. Explicit task deadlines and explicit Worker hard limits remain effective. Resource admission cannot guarantee that an unknown native command or an already-running SDK avoids OS allocation failure.

AgentTurn owns model admission for both execution modes. Preparation, recording and dispatch do not introduce independent priority queues. Workers retain only admitted transport requests awaiting startup and release ownership after the protocol confirms disposal. The in-process executor retains provider readers until consumption or confirmed disposal. Idle Worker reclamation never cancels active turns merely to satisfy a reduced ceiling.

Resource state is transient; it does not create a database, Session state or migration. The authoritative transcript, permissions, Workspace claims and provider retry coordinator retain their existing owners. See the [decision](../decisions/implemented/architecture/2026-11-02-runtime-memory-admission.md).
