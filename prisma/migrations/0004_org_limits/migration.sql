-- CreateTable
CREATE TABLE "OrgLimit" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "limit" DOUBLE PRECISION,
    "reservePct" INTEGER NOT NULL DEFAULT 5,

    CONSTRAINT "OrgLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgLimit_orgId_kind_key" ON "OrgLimit"("orgId", "kind");

-- AddField
ALTER TABLE "Request" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'text';

-- AddForeignKey
ALTER TABLE "OrgLimit" ADD CONSTRAINT "OrgLimit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mutable tier (the 0002 contract: new tables default append-only, fail
-- closed) — the operator sets account limits at runtime, so the app role
-- needs full DML here, like KeyLimit.
GRANT UPDATE, DELETE ON "OrgLimit" TO jatin_app;
