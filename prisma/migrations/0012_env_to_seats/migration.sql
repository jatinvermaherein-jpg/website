-- Onboarding was incomplete in one specific way: a seat that joined ITSELF
-- got the NAMES of the project's env vars and never the values, so "an agent
-- has the same access you do" was true only for a seat the crew spawned.
--
-- This flag decides, per variable, whether a self-joined seat may receive the
-- value. It is OFF by default: opening an environment is a deliberate act by
-- the operator, not something a joining agent can assume. Every reveal is
-- audited, per value, with the seat's name.
ALTER TABLE "ProjectEnv" ADD COLUMN "seatVisible" BOOLEAN NOT NULL DEFAULT false;
