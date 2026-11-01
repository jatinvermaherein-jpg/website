-- 0010 — the work loop
--
-- A task can now name the fidelity level it must be proven at and the ledger
-- row it satisfies, and carries the two timestamps the claim/submit steps
-- need. Everything else the loop uses (owner, witness, status, artifacts)
-- was already in the schema; it was never reachable.
ALTER TABLE "Task" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'local-stack';
ALTER TABLE "Task" ADD COLUMN "rowId" TEXT;
ALTER TABLE "Task" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "submittedAt" TIMESTAMP(3);

CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");
