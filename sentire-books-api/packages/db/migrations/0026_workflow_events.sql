-- ════════════════════════════════════════════════════════════════════════════
-- M3.2 — the immutable workflow-history table.
-- ════════════════════════════════════════════════════════════════════════════
-- There is no record anywhere of who verified, approved or posted a voucher or
-- journal entry; the ledger-reaching documents carry only created_by and a bare
-- posted_at. This creates the table that holds that trail, with the DATABASE —
-- not the handler — guaranteeing a written row can never be rewritten.
--
-- Merged proposal §3, as amended by PASS 4:
--   • C1 — NO lifetime UNIQUE on (org, document_type, document_id, action). A
--     rejected-then-resubmitted document must be able to record its second
--     'submit'. Ordering is event_at + id; three event_at indexes, no such UNIQUE.
--   • C2 — actor_id text REFERENCES app_users(id): app_users.id is text since
--     0007_auth_text_ids.sql, so the FK is text→text and valid.
--   • Both dates (PASS 4 recommendation, this unit's B1): accounting_date is the
--     document's OWN date (the fiscal period a future period-lock reasons about);
--     event_at is the calendar wall-clock the action happened at. §3's single
--     `occurred_at` is renamed `event_at` and `accounting_date` is added — the
--     one deliberate divergence from §3's column list.
--   • R29 — a verification skipped BY CONFIGURATION (autoBypass) is recorded via
--     authority_basis = 'auto_bypass', exactly parallel to single-operator's
--     authority_basis = 'single_operator' (C4). ONE field, not two switches
--     (R28): an auditor tells "bypassed by policy" from "never happened" by the
--     presence of an approve row whose authority_basis says auto_bypass, versus
--     an approve with authority_basis='route' and no verify row.
--
-- SCOPE (R31): table, RLS, write-once trigger. NO enforcement — no self-approval
-- trigger (that reads created_by off the document tables; M3.3, its own
-- migration), no handler writes an event here. Purely additive, so this delta is
-- safe to apply ahead of the code that will read it.

CREATE TABLE IF NOT EXISTS workflow_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- What moved. document_no is denormalised on purpose: the history must stay
  -- readable even if the source row is later cancelled or renumbered.
  document_type  text        NOT NULL,
  document_id    uuid        NOT NULL,
  document_no    text,

  -- Who moved it. Email and role are SNAPSHOTS: a trail that changes when
  -- someone is later promoted or offboarded is not a trail.
  actor_id       text        NOT NULL REFERENCES app_users(id),
  actor_email    text        NOT NULL,
  actor_role     text        NOT NULL,

  -- What happened.
  action         text        NOT NULL,   -- submit|verify|approve|reject|post|void|issue|cancel
  from_status    text,                   -- null on the create event
  to_status      text        NOT NULL,
  remarks        text,                   -- mandatory on reject (CHECK below)

  -- Why it was allowed.
  --   'route' | 'delegate:<email>' | 'auto_bypass' | 'role_fallback'
  --   | 'admin_override' | 'single_operator'
  -- 'auto_bypass' records a configuration-skipped verification (R29);
  -- 'single_operator' records a permitted self-approval (PASS 4 C4).
  authority_basis text       NOT NULL,

  -- The ledger consequence, when there was one.
  journal_entry_id uuid,

  -- Both dates. accounting_date = the document's own date (voucher_date /
  -- entry_date); event_at = calendar wall-clock. Neither substitutes for the
  -- other: a back-dated entry has an accounting_date in its own period and an
  -- event_at of now.
  accounting_date date        NOT NULL,
  event_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_events_remarks_on_reject_chk
    CHECK (action <> 'reject' OR (remarks IS NOT NULL AND length(btrim(remarks)) > 0))
);

-- Ordering is event_at + id. NO lifetime UNIQUE on (org, document, action) — C1.
CREATE INDEX IF NOT EXISTS workflow_events_org_doc_idx   ON workflow_events (org_id, document_type, document_id, event_at);
CREATE INDEX IF NOT EXISTS workflow_events_org_actor_idx ON workflow_events (org_id, actor_id, event_at DESC);
CREATE INDEX IF NOT EXISTS workflow_events_org_time_idx  ON workflow_events (org_id, event_at DESC);

-- ── RLS: deny-by-default org isolation (house helper current_org_id()) ──────────
ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON workflow_events;
CREATE POLICY org_isolation ON workflow_events
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- ── Grants: SELECT + INSERT ONLY (defence #1) ──────────────────────────────────
-- 0001_rls.sql's ALTER DEFAULT PRIVILEGES auto-grants SELECT/INSERT/UPDATE/DELETE
-- to the app role on every new table, so the REVOKE is the operative line: the
-- API role is INCAPABLE of rewriting history, so a bug cannot do it either.
GRANT  SELECT, INSERT   ON workflow_events TO sentire_books_app;
REVOKE UPDATE, DELETE   ON workflow_events FROM sentire_books_app;

-- ── Write-once trigger (defence #2, independent of the grant) ───────────────────
-- A UNIQUE index is not immutability. DELETE is rejected outright; UPDATE may
-- only FILL a column that was NULL (NULL→value) — it can never change a set
-- value (value→different) nor blank one (value→NULL). Mirrors trg_entry_immutable
-- (0000_init.sql).
CREATE OR REPLACE FUNCTION prevent_workflow_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_events is append-only; history cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- UPDATE: permit NULL→value per column; reject value→different and value→NULL.
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
