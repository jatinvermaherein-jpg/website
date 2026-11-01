-- 0008 — per-key model liveness (catalog knows names; liveness proves each key serves them)
CREATE TABLE "ModelLiveness" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelLiveness_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ModelLiveness" ADD CONSTRAINT "ModelLiveness_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ProviderCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ModelLiveness_credentialId_provider_model_key" ON "ModelLiveness"("credentialId", "provider", "model");
CREATE INDEX "ModelLiveness_provider_model_idx" ON "ModelLiveness"("provider", "model");
