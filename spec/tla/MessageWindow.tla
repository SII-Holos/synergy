------------------------------- MODULE MessageWindow -------------------------------
\* Bounded model of one session message window: latest/history, pendingLatest,
\* cursor stale, prepend, and cap. The rules are the ones in
\* docs/architecture/frontend-data-sync.md (Message Window and Cursor
\* Pagination, Return to latest, Invariants). The reducer follows
\* apps/web/src/context/session-message-window.ts. Stale-cursor recovery
\* follows apps/web/src/context/session-message-page-recovery.ts: a stale
\* cursor does not prepend; it refetches latest.
\*
\* Message ids are 1..MsgCount in canonical order (time, then id). The window
\* is a set under that order. Dependency-root retention is not modeled: the
\* runtime may keep referenced roots above the primary cap, and this model
\* does not. Older paging keeps the oldest Cap ids of the combined slice.
\* Every requested older page advances the reading window. Evicting newer
\* rows sets the tail flag, so return-to-latest can recover them.
\*
\* pending holds ids strictly newer than the window maximum. An older id that
\* is only absent does not enter pending. CandidatePendingIsNewer is that
\* claim; it is checked as InvPendingIsNewer. An empty window has no maximum,
\* so a reconcile does not admit an id and does not drop ids already pending.
\*
\* An unloaded bucket ignores message events. Removal of a pending-only id
\* drops that id and does not change the visible window. Removal of a visible
\* id preserves mode and tailMissingLatest.
\*
\* Checked with the TLA+ tools (Leslie Lamport, Specifying Systems;
\* https://github.com/tlaplus/tlaplus). This file is the model, not a runtime.

EXTENDS Integers, FiniteSets

CONSTANTS Cap, MsgCount, Page
ASSUME Cap \in Nat /\ Cap >= 1
ASSUME MsgCount \in Nat /\ MsgCount >= 1
ASSUME Page \in Nat /\ Page >= 1

VARIABLES
  published, nextId, loaded, mode, window, pending, pendingLatest, tailMissing,
  cursorStale, lastAction, prev, lastEvicted, lastOlder

vars == <<published, nextId, loaded, mode, window, pending, pendingLatest,
          tailMissing, cursorStale, lastAction, prev, lastEvicted, lastOlder>>

Messages == 1..MsgCount

MinSet(S) == CHOOSE x \in S : \A y \in S : x <= y
MaxSet(S) == CHOOSE x \in S : \A y \in S : x >= y

RECURSIVE Largest(_, _)
Largest(S, k) ==
  IF Cardinality(S) <= k THEN S
  ELSE Largest(S \ {MinSet(S)}, k)

RECURSIVE Smallest(_, _)
Smallest(S, k) ==
  IF Cardinality(S) <= k THEN S
  ELSE Smallest(S \ {MaxSet(S)}, k)

OlderThan(S) == {m \in published : m < MinSet(S)}
OlderPage(S) == Largest(OlderThan(S), Page)

PendingAfter(source, kept, evicted) ==
  IF kept = {} THEN {p \in source : p \notin evicted}
  ELSE {p \in source : p \notin kept /\ p \notin evicted /\ p > MaxSet(kept)}

Snap == [
  window |-> window,
  pending |-> pending,
  mode |-> mode,
  tail |-> tailMissing,
  pendingLatest |-> pendingLatest
]

Init ==
  /\ published = {}
  /\ nextId = 1
  /\ loaded = FALSE
  /\ mode = "latest"
  /\ window = {}
  /\ pending = {}
  /\ pendingLatest = FALSE
  /\ tailMissing = FALSE
  /\ cursorStale = FALSE
  /\ lastAction = "init"
  /\ prev = Snap
  /\ lastEvicted = {}
  /\ lastOlder = {}

Publish ==
  /\ nextId <= MsgCount
  /\ published' = published \cup {nextId}
  /\ nextId' = nextId + 1
  /\ lastAction' = "publish"
  /\ prev' = Snap
  /\ lastEvicted' = {}
  /\ lastOlder' = {}
  /\ UNCHANGED <<loaded, mode, window, pending, pendingLatest, tailMissing, cursorStale>>

EnterLatest(action) ==
  /\ loaded' = TRUE
  /\ mode' = "latest"
  /\ window' = Largest(published, Cap)
  /\ pending' = {}
  /\ pendingLatest' = FALSE
  /\ tailMissing' = FALSE
  /\ cursorStale' = FALSE
  /\ lastAction' = action
  /\ prev' = Snap
  /\ lastEvicted' = {}
  /\ lastOlder' = {}
  /\ UNCHANGED <<published, nextId>>

Load ==
  /\ ~loaded
  /\ EnterLatest("latest")

ReturnLatest ==
  /\ loaded
  /\ EnterLatest("returnLatest")

StaleRecover ==
  /\ loaded
  /\ cursorStale
  /\ EnterLatest("staleRecover")

MarkCursorStale ==
  /\ loaded
  /\ mode = "history"
  /\ ~cursorStale
  /\ cursorStale' = TRUE
  /\ lastAction' = "cursorStale"
  /\ prev' = Snap
  /\ lastEvicted' = {}
  /\ lastOlder' = {}
  /\ UNCHANGED <<published, nextId, loaded, mode, window, pending, pendingLatest, tailMissing>>

Prepend ==
  /\ loaded
  /\ ~cursorStale
  /\ window # {}
  /\ OlderPage(window) # {}
  /\ LET older == OlderPage(window)
         combined == window \cup older
         kept == Smallest(combined, Cap)
         evicted == combined \ kept
         nextPending == PendingAfter(pending, kept, evicted)
     IN /\ window' = kept
        /\ pending' = nextPending
        /\ pendingLatest' = (nextPending # {})
        /\ mode' = "history"
        /\ tailMissing' = (tailMissing \/ evicted # {})
        /\ lastEvicted' = evicted
        /\ lastOlder' = older
        /\ lastAction' = "prepend"
        /\ prev' = Snap
        /\ UNCHANGED <<published, nextId, loaded, cursorStale>>

Reconcile(id) ==
  /\ id \in published
  /\ prev' = Snap
  /\ lastEvicted' = {}
  /\ lastOlder' = {}
  /\ UNCHANGED <<published, nextId, loaded, cursorStale>>
  /\ IF ~loaded
     THEN /\ lastAction' = "ignore"
          /\ window' = window
          /\ pending' = pending
          /\ pendingLatest' = pendingLatest
          /\ mode' = mode
          /\ tailMissing' = tailMissing
     ELSE IF mode = "history" /\ id \notin window /\ window # {} /\ id > MaxSet(window)
          THEN /\ pending' = pending \cup {id}
               /\ pendingLatest' = TRUE
               /\ window' = window
               /\ mode' = "history"
               /\ tailMissing' = tailMissing
               /\ lastAction' = "pending"
          ELSE IF mode = "history" /\ id \notin window
               THEN LET next == IF window = {} THEN pending ELSE pending \ {id}
                    IN /\ pending' = next
                       /\ pendingLatest' = (next # {})
                       /\ window' = window
                       /\ mode' = "history"
                       /\ tailMissing' = tailMissing
                       /\ lastAction' = "olderIgnored"
          ELSE IF mode = "history"
               THEN LET next == pending \ {id}
                    IN /\ lastAction' = "historyTouch"
                       /\ window' = window
                       /\ pending' = next
                       /\ pendingLatest' = (next # {})
                       /\ mode' = "history"
                       /\ tailMissing' = tailMissing
               ELSE /\ window' = Largest(window \cup {id}, Cap)
                    /\ pending' = {}
                    /\ pendingLatest' = FALSE
                    /\ tailMissing' = FALSE
                    /\ mode' = "latest"
                    /\ lastAction' = "latestReconcile"

Remove(id) ==
  /\ id \in published
  /\ published' = published \ {id}
  /\ prev' = Snap
  /\ lastEvicted' = {}
  /\ lastOlder' = {}
  /\ UNCHANGED <<nextId, loaded, mode, tailMissing, cursorStale>>
  /\ IF ~loaded
     THEN /\ window' = window
          /\ pending' = pending
          /\ pendingLatest' = pendingLatest
          /\ lastAction' = "removeUnloaded"
     ELSE IF id \in (window \cup pending)
          THEN /\ window' = window \ {id}
               /\ pending' = pending \ {id}
               /\ pendingLatest' = ((pending \ {id}) # {})
               /\ lastAction' = "remove"
          ELSE /\ window' = window
               /\ pending' = pending
               /\ pendingLatest' = pendingLatest
               /\ lastAction' = "removeAbsent"

Next ==
  \/ Publish
  \/ Load
  \/ ReturnLatest
  \/ StaleRecover
  \/ MarkCursorStale
  \/ Prepend
  \/ \E id \in Messages : Reconcile(id)
  \/ \E id \in Messages : Remove(id)

Spec == Init /\ [][Next]_vars

Actions == {
  "init", "publish", "latest", "returnLatest", "staleRecover", "cursorStale",
  "prepend", "pending", "olderIgnored", "historyTouch", "latestReconcile", "ignore",
  "remove", "removeUnloaded", "removeAbsent"
}

TypeOK ==
  /\ published \subseteq Messages
  /\ nextId \in 1..(MsgCount + 1)
  /\ \A m \in published : m < nextId
  /\ loaded \in BOOLEAN
  /\ mode \in {"latest", "history"}
  /\ window \subseteq Messages
  /\ pending \subseteq Messages
  /\ Cardinality(window) <= Cap
  /\ pendingLatest \in BOOLEAN
  /\ tailMissing \in BOOLEAN
  /\ cursorStale \in BOOLEAN
  /\ lastAction \in Actions
  /\ prev.mode \in {"latest", "history"}
  /\ prev.window \subseteq Messages
  /\ prev.pending \subseteq Messages
  /\ prev.tail \in BOOLEAN
  /\ prev.pendingLatest \in BOOLEAN
  /\ lastEvicted \subseteq Messages
  /\ lastOlder \subseteq Messages
  /\ Cardinality(lastOlder) <= Page

InvPendingFlag == pendingLatest <=> (pending # {})

InvPendingDisjoint == pending \cap window = {}

InvCap == Cardinality(window) <= Cap

InvSubset == window \subseteq published /\ pending \subseteq published

InvTailOnlyInHistory == tailMissing => mode = "history"

InvLatestClean ==
  mode = "latest" =>
    (/\ ~pendingLatest
     /\ pending = {}
     /\ ~tailMissing
     /\ ~cursorStale)

InvUnloaded ==
  ~loaded =>
    (/\ window = {}
     /\ pending = {}
     /\ ~pendingLatest
     /\ ~tailMissing
     /\ mode = "latest"
     /\ ~cursorStale)

InvCursorOnlyHistory == cursorStale => (loaded /\ mode = "history")

InvLatestPageIsSuffix ==
  (lastAction \in {"latest", "returnLatest", "staleRecover"}) =>
    (/\ loaded
     /\ mode = "latest"
     /\ window = Largest(published, Cap)
     /\ pending = {}
     /\ ~pendingLatest
     /\ ~tailMissing
     /\ ~cursorStale)

\* Backward paging advances the oldest visible id and retains a recovery
\* marker for the newer rows evicted to keep memory bounded.
InvHistoryPagingProgress ==
  lastAction = "prepend" =>
    (/\ mode = "history"
     /\ loaded
     /\ prev.window # {}
     /\ Cardinality(lastOlder) \in 1..Page
     /\ lastOlder = Largest({m \in published : m < MinSet(prev.window)}, Page)
     /\ window = Smallest(prev.window \cup lastOlder, Cap)
     /\ window \cup lastEvicted = prev.window \cup lastOlder
     /\ window \cap lastEvicted = {}
     /\ \A e \in lastEvicted : \A w \in window : e > w
     /\ MinSet(window) < MinSet(prev.window)
     /\ pending = PendingAfter(prev.pending, window, lastEvicted)
     /\ pendingLatest <=> (pending # {})
     /\ tailMissing = (prev.tail \/ lastEvicted # {}))

\* CandidatePendingIsNewer, checked. A non-empty window's pending ids are
\* strictly newer than its maximum. The old counterexample parked id 1 after
\* a capped history window of {2, 3}; that state is not reachable.
InvPendingIsNewer ==
  window # {} => \A p \in pending : p > MaxSet(window)

CandidatePendingIsNewer == InvPendingIsNewer

InvPendingStep ==
  lastAction = "pending" =>
    (/\ mode = "history"
     /\ prev.mode = "history"
     /\ window = prev.window
     /\ window # {}
     /\ tailMissing = prev.tail
     /\ pendingLatest
     /\ prev.pending \subseteq pending
     /\ Cardinality(pending) \in {Cardinality(prev.pending), Cardinality(prev.pending) + 1}
     /\ (pending \ window) = pending
     /\ \A p \in pending : p > MaxSet(window))

InvOlderIgnored ==
  lastAction = "olderIgnored" =>
    (/\ mode = "history"
     /\ prev.mode = "history"
     /\ window = prev.window
     /\ tailMissing = prev.tail
     /\ pending \subseteq prev.pending
     /\ Cardinality(prev.pending \ pending) \in {0, 1}
     /\ pendingLatest <=> (pending # {})
     /\ (window # {} => \A p \in pending : p > MaxSet(window)))

InvHistoryTouchPreserves ==
  lastAction = "historyTouch" =>
    (/\ mode = "history"
     /\ window = prev.window
     /\ pending \subseteq prev.pending
     /\ (prev.pending \ pending) \subseteq window
     /\ Cardinality(prev.pending \ pending) \in {0, 1}
     /\ pendingLatest <=> (pending # {})
     /\ tailMissing = prev.tail)

InvRemovePreserves ==
  lastAction = "remove" =>
    (/\ mode = prev.mode
     /\ tailMissing = prev.tail
     /\ window \subseteq prev.window
     /\ pending \subseteq prev.pending
     /\ \/ (/\ window = prev.window
            /\ Cardinality(pending) = Cardinality(prev.pending) - 1)
        \/ (/\ Cardinality(window) = Cardinality(prev.window) - 1
            /\ pending \subseteq prev.pending))

InvIgnoreUnloaded ==
  (lastAction \in {"ignore", "removeUnloaded"}) =>
    (/\ ~loaded
     /\ window = {}
     /\ pending = {})

=============================================================================
