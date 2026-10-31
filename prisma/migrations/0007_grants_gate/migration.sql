-- 0007_grants_gate: Law 2.2 / V4 §10 — the CI grants gate requires every
-- mutable table to hold full DML (SELECT, INSERT, UPDATE, DELETE) for the
-- runtime role, and every schema model to be classified in the gate's
-- policy lists. Two gaps:
--   · OrgLimit (0004) got UPDATE/DELETE but missed SELECT/INSERT — the
--     runtime runs as jatin_app, so the operator's "save limits" would
--     have failed live. Grant the full four.
--   · ModelSighting (0006) got SELECT/INSERT/UPDATE — complete it with
--     DELETE (stale sightings may be purged).
-- Re-granting a held privilege is a no-op, so this is safe to apply
-- everywhere.

GRANT SELECT, INSERT, UPDATE, DELETE ON "OrgLimit" TO jatin_app;
GRANT DELETE ON "ModelSighting" TO jatin_app;
