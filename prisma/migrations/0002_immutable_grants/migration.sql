-- 0002: immutable grants — the append-only law made STRUCTURAL (law book v4).
--
-- The runtime connects as `jatin_app`, not the owner. Two tiers:
--
--   MUTABLE (full DML): the working tables.
--   APPEND-ONLY (SELECT + INSERT + REFERENCES, NO UPDATE/DELETE):
--     "Event", "Verdict", "LedgerRow", "Handover", "Ruleset",
--     "EnvVersion", "Breach", "AuditLog"
--
-- LedgerRow is a transition log (V4 §10): current state = latest entry per
-- rowId — corrections are appended, never rewritten. Event/Verdict are the
-- typed evidence stream. Ruleset/EnvVersion are pinned versions. Breach and
-- AuditLog can only grow — tampering with an audit trail is the crime the
-- trail exists to catch.
--
-- Ownership (migrations, emergency repair) stays with the DB superuser role
-- `jatin`. Production: Railway's app env points at jatin_app.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jatin_app') THEN
    CREATE ROLE jatin_app LOGIN PASSWORD 'jatin_app';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE jatin TO jatin_app;
GRANT USAGE ON SCHEMA public TO jatin_app;

-- base: read + insert + reference on everything
GRANT SELECT, INSERT, REFERENCES ON ALL TABLES IN SCHEMA public TO jatin_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jatin_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, REFERENCES ON TABLES TO jatin_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO jatin_app;

-- mutable tier: full DML on the working tables (explicit — a new table
-- defaults to append-only until someone grants it up; fail closed)
GRANT UPDATE, DELETE ON
  "ApiKey", "Artifact", "BenchManifest", "Cursor", "KeyLimit",
  "Membership", "Model", "ModelAlias", "Org", "Project",
  "ProjectEnv", "ProjectModelRoute", "ProviderCredential", "QuotaWindow",
  "Request", "Seat", "SeatKey", "SeatProject", "Session", "Task",
  "UsageRollup", "User", "Verification", "Waiver"
  TO jatin_app;
