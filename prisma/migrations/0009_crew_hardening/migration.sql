-- 0009 — crew hardening + versioned project documents
--
-- 1. Task.runId: the crew runner looked its task up by a JSON path
--    (artifactRefs->'$taskId'), which is unindexed and silently returns
--    null if the shape ever changes. Make it a column.
-- 2. ProjectDoc: append-only versioned documents per project (rules,
--    specs, attachments). New version supersedes; nothing is overwritten.

-- 1 ─────────────────────────────────────────────────────────────────────
ALTER TABLE "Task" ADD COLUMN "runId" TEXT;

-- backfill from the existing JSON shape, so in-flight runs stay addressable
UPDATE "Task"
   SET "runId" = "artifactRefs"->>'$taskId'
 WHERE "artifactRefs" IS NOT NULL
   AND "artifactRefs"->>'$taskId' IS NOT NULL;

CREATE UNIQUE INDEX "Task_runId_key" ON "Task"("runId");

-- 2 ─────────────────────────────────────────────────────────────────────
CREATE TABLE "ProjectDoc" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'doc',
    "title" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'text/markdown',
    "bytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectDoc_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectDoc_projectId_slug_version_key"
    ON "ProjectDoc"("projectId", "slug", "version");

CREATE INDEX "ProjectDoc_projectId_kind_idx"
    ON "ProjectDoc"("projectId", "kind");

ALTER TABLE "ProjectDoc"
    ADD CONSTRAINT "ProjectDoc_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
