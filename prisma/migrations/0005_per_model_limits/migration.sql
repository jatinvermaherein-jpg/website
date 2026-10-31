-- AlterTable: per-model dimension on account limits
ALTER TABLE "OrgLimit" ADD COLUMN "model" TEXT;

-- DropIndex: replace the account-only unique with the per-model one
DROP INDEX "OrgLimit_orgId_kind_key";

-- CreateIndex: NULL model = the whole account. NULLS NOT DISTINCT keeps the
-- account-wide rows unique per (org, kind), the way Prisma's @@unique means.
CREATE UNIQUE INDEX "OrgLimit_orgId_model_kind_key" ON "OrgLimit"("orgId", "model", "kind") NULLS NOT DISTINCT;
