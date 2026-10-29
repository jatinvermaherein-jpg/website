-- Phase 10 — the fidelity ladder: every join-spine row declares the
-- environment level it demands. Verdicts only run UP the ladder, so a
-- production row refuses a local-stack verdict. Existing rows inherit
-- local-stack (the level this repo's dev bench actually is).
ALTER TABLE "LedgerRow" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'local-stack';
