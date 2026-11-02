-- THE INVARIANT, IN THE STORAGE LAYER.
--
-- "Everything is audited by an auditor" was enforced only in the route that
-- happens to close a task. It had already been bypassed once: crew.ts wrote
-- `done` when a RUN finished, closing work with no auditor, no witness and no
-- verdict. A rule that lives only in the callers is a rule that will be
-- forgotten by the next caller.
--
-- So the database refuses it. A task cannot be `done` unless a seat has
-- witnessed it. `unproven` still leaves a witnessId (somebody looked and
-- refused to pass), which is correct: the row records that it WAS audited.
--
-- This is a floor, not a substitute for the route rules — the route also
-- enforces who may witness, that it is not their own work, and that the
-- verdict survives the demotion law.

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_done_requires_a_witness"
  CHECK (status <> 'done' OR "witnessId" IS NOT NULL);
