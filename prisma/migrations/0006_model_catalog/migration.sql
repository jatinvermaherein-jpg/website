-- 0006_model_catalog: the providers' model lists change (new models ship,
-- old ones retire) — often daily. The gateway keeps a sighting table so the
-- operator dashboard and the customer's model list can say "this model is
-- in the provider's catalog as of <date>", and refresh at most once a day
-- per pool key (timestamp below) instead of on every request.

CREATE TABLE "ModelSighting" (
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelSighting_provider_model_pk" PRIMARY KEY ("provider", "model")
);

ALTER TABLE "ProviderCredential" ADD COLUMN "lastCatalogCheckedAt" TIMESTAMP(3);

-- the runtime role reads/writes sightings (migrations run as owner, queries as jatin_app)
GRANT SELECT, INSERT, UPDATE ON "ModelSighting" TO jatin_app;
