// @jatin/crew — seats, the stream, tasks, ledger, handovers, bench.
// Phases 6–7: one stream per project (validate at post, fail open on read,
// versioned envelope, cursor), the join spine (one key → atomic provision →
// mandatory falsifiable admission), death protocol (heartbeat, wip commit,
// verdict quarantine, bench resumption).
// Reference implementation: workspace/reference/seat-server.mjs.

export const CREW_PHASE = "6-7";
