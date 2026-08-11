-- ════════════════════════════════════════════════════════════════════════════
-- livedbdelta0026.sql — owner-run production delta for migration 0026.
-- ════════════════════════════════════════════════════════════════════════════
-- Run this in pgAdmin AS THE TABLE OWNER (not the sentire_books_app role) BEFORE
-- deploying the M3.3 code — that is the first code that writes workflow_events;
-- deploying it against a database without this table would 500 on every governed
-- transition. M3.2 itself ships NO reader, so applying this ahead of M3.2's own
-- deploy is equally safe. Idempotent: re-running is a no-op.
--
-- Purely additive — a new table, its RLS policy, its grants and its write-once
-- trigger. Touches nothing in migrations 0000–0025.

CREATE TABLE IF NOT EXISTS workflow_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_type  text        NOT NULL,
  document_id    uuid        NOT NULL,
  document_no    text,
  actor_id       text        NOT NULL REFERENCES app_users(id),
  actor_email    text        NOT NULL,
  actor_role     text        NOT NULL,
  action         text        NOT NULL,   -- submit|verify|approve|reject|post|void|issue|cancel
  from_status    text,                   -- null on the create event
  to_status      text        NOT NULL,
  remarks        text,                   -- mandatory on reject (CHECK below)
  -- 'route' | 'delegate:<email>' | 'auto_bypass' | 'role_fallback'
  -- | 'admin_override' | 'single_operator'
  authority_basis text       NOT NULL,
  journal_entry_id uuid,
  accounting_date date        NOT NULL,   -- the document's OWN date (its period)
  event_at        timestamptz NOT NULL DEFAULT now(),  -- calendar wall-clock
  CONSTRAINT workflow_events_remarks_on_reject_chk
    CHECK (action <> 'reject' OR (remarks IS NOT NULL AND length(btrim(remarks)) > 0))
);

CREATE INDEX IF NOT EXISTS workflow_events_org_doc_idx   ON workflow_events (org_id, document_type, document_id, event_at);
CREATE INDEX IF NOT EXISTS workflow_events_org_actor_idx ON workflow_events (org_id, actor_id, event_at DESC);
CREATE INDEX IF NOT EXISTS workflow_events_org_time_idx  ON workflow_events (org_id, event_at DESC);

ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON workflow_events;
CREATE POLICY org_isolation ON workflow_events
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- SELECT + INSERT ONLY. The REVOKE is operative: 0001's ALTER DEFAULT PRIVILEGES
-- auto-grants all four verbs to the app role on new tables.
GRANT  SELECT, INSERT   ON workflow_events TO sentire_books_app;
REVOKE UPDATE, DELETE   ON workflow_events FROM sentire_books_app;

CREATE OR REPLACE FUNCTION prevent_workflow_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_events is append-only; history cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.id                  IS NOT NULL AND NEW.id                  IS DISTINCT FROM OLD.id)
  OR (OLD.org_id              IS NOT NULL AND NEW.org_id              IS DISTINCT FROM OLD.org_id)
  OR (OLD.document_type       IS NOT NULL AND NEW.document_type       IS DISTINCT FROM OLD.document_type)
  OR (OLD.document_id         IS NOT NULL AND NEW.document_id         IS DISTINCT FROM OLD.document_id)
  OR (OLD.document_no         IS NOT NULL AND NEW.document_no         IS DISTINCT FROM OLD.document_no)
  OR (OLD.actor_id            IS NOT NULL AND NEW.actor_id            IS DISTINCT FROM OLD.actor_id)
  OR (OLD.actor_email         IS NOT NULL AND NEW.actor_email         IS DISTINCT FROM OLD.actor_email)
  OR (OLD.actor_role          IS NOT NULL AND NEW.actor_role          IS DISTINCT FROM OLD.actor_role)
  OR (OLD.action              IS NOT NULL AND NEW.action              IS DISTINCT FROM OLD.action)
  OR (OLD.from_status         IS NOT NULL AND NEW.from_status         IS DISTINCT FROM OLD.from_status)
  OR (OLD.to_status           IS NOT NULL AND NEW.to_status           IS DISTINCT FROM OLD.to_status)
  OR (OLD.remarks             IS NOT NULL AND NEW.remarks             IS DISTINCT FROM OLD.remarks)
  OR (OLD.authority_basis     IS NOT NULL AND NEW.authority_basis     IS DISTINCT FROM OLD.authority_basis)
  OR (OLD.journal_entry_id    IS NOT NULL AND NEW.journal_entry_id    IS DISTINCT FROM OLD.journal_entry_id)
  OR (OLD.accounting_date     IS NOT NULL AND NEW.accounting_date     IS DISTINCT FROM OLD.accounting_date)
  OR (OLD.event_at            IS NOT NULL AND NEW.event_at            IS DISTINCT FROM OLD.event_at)
  THEN
    RAISE EXCEPTION 'workflow_events rows are write-once; a set value cannot be changed or nulled.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workflow_event_immutable ON workflow_events;
CREATE TRIGGER trg_workflow_event_immutable
  BEFORE UPDATE OR DELETE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION prevent_workflow_event_mutation();
