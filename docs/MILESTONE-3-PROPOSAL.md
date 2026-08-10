# Milestone 3 — Controls that actually govern

**Status: PROPOSAL — no code written. Awaiting approval.**

Every claim below was read out of the source on `main` at the M2 merge point.
Where something could not be verified, it is marked **CONFIRM**.

---

## 0. The headline finding

> **A single user holding the `poster` role can create a voucher, verify it,
> approve it, and post a real journal entry to the general ledger — alone, with
> no second person involved and no record that it happened.**

**This is not a code reading — it was executed.** A throwaway probe drove the
real `voucherRoutes` against a real Postgres, as a user holding **only** the
`poster` role (not admin):

```
── PROBE RESULT ─────────────────────────────────────────────
actor role                : poster (single user, admin@demo.scalebooks.local)
voucher                   : PV202608-0001
transitions               : for_verification:200  verified:200  for_approval:200  approved:200
final voucher status      : approved
voucher.createdBy         : 00000000-0000-0000-0000-0000000000b1
journal entry POSTED      : JE202608-0001  status=posted
JE createdBy              : 00000000-0000-0000-0000-0000000000b1
same person start to end? : YES
─────────────────────────────────────────────────────────────
```

Four transitions, four `200`s, one human, one real posted journal entry. The
probe was deleted after running; M3.2's acceptance check turns it into a
permanent test that asserts the opposite.

That is not a bug in one handler. It is three independent gaps lining up:

1. **`createdBy` is never compared to the acting user.** Verified by grep across
   every route and ledger module: `createdBy` appears only in *writes*
   (`crudFactory.ts:128`, `createVoucherDraftCore`) and in *display joins*
   (`vouchers.ts:86`, `journal.ts:120`, `disbursements.ts:109`). It is never read
   for an authorization decision anywhere in the codebase.

2. **The role sets overlap.** `vouchers.ts:33-34`:
   ```ts
   const POSTERS   = ["poster", "approver", "admin"] as const;
   const VERIFIERS = ["verifier", "poster", "approver", "admin"] as const;
   ```
   `poster`, `approver` and `admin` each satisfy **both** gates. So the "two
   different people" assumption the workflow encodes is never checked.

3. **Nothing is recorded.** There is no audit table (confirmed: zero
   `CREATE TABLE` matches for audit/history/activity across all 25 migrations),
   and `vouchers` and `journal_entries` carry no `approved_by` stamp at all — the
   transition handler writes `{ status: to }` and nothing else.

The status *graph* is enforced (`VOUCHER_TRANSITIONS` / `JOURNAL_TRANSITIONS` are
checked server-side, correctly). What is missing is **who may move a document
along it, and the record that they did.**

---

## 1. What exists today

### 1.1 Roles — workspace-wide, one per user

`user_role` enum (`schema.ts:53`): `maker` · `verifier` · `approver` · `poster` ·
`admin`. Stored on `app_users.role`, one row per (user, org).

`requireAuth` re-resolves the role **from the database on every request**, keyed
on the verified token email + `x-org-id` — never from a token claim. That part is
sound and M3 does not change it.

The gates built on it are coarse:

| Helper | Roles | Used by |
|---|---|---|
| `canPost` | poster, admin | direct JE post |
| `canWorkflowPost` / `requireWorkflowPoster` | poster, approver, admin | JE status, loan/asset booking, invoice `/issue`, collection `/post` |
| `isVerifier` (vouchers.ts) | verifier, poster, approver, admin | voucher verify/reject |
| `isPoster` (vouchers.ts) | poster, approver, admin | voucher approve/pay |

**Authority is all-or-nothing per workspace.** A `poster` can approve a ₱5,000
supplies voucher and a ₱5,000,000 one, in any module, forever.

### 1.2 Approval routing — configured, displayed, never enforced

`org_settings.approval_routing` (jsonb) holds:

```jsonc
{
  "routes": [
    { "id": "…", "documentType": "Vouchers",
      "makerEmail": "…", "verifierEmail": "…", "approverEmail": "…",
      "autoBypass": false }        // true ⇒ skip the verification step
  ],
  "delegates": [
    { "id": "…", "delegatorEmail": "…", "delegateEmail": "…",
      "documentTypes": ["Vouchers", "Journal"],
      "fromDate": "2026-08-01", "toDate": "2026-08-15", "isActive": true }
  ]
}
```

Document types the Settings screen offers (`SettingsPage.jsx:15`):
`Vouchers` · `Weekly Projections` · `Disbursements` · `Check Voucher` · `Journal`.

**Who reads it:**

| Consumer | Use |
|---|---|
| `SettingsPage.jsx` | authoring |
| `VoucherPdfModal` / `CheckVoucherPdfModal` | printed signatory block |
| `DisbursementsPage` | display |
| `ApprovalsPage.jsx:245` | picks which documents land in your inbox |
| **API** | **`settings.ts` stores and returns it. `dataAdmin.ts` exports it. Nothing else.** |

So the named approver has **no authority the server recognises**, and a person
*not* named on any route can approve freely if they hold the role. The Approvals
inbox is a filtered view, not a gate — its own comment says so:

> *"No maker filtering — the verifier/approver sees ALL docs of that type at the
> right status, regardless of who created them."*

### 1.3 `module_policies` — same story

`org_settings.module_policies` carries `requireVoucherApproval`,
`enabledVoucherTypes`, `requirePurposeCategory`, `staleCheckDays`,
`requireVoidReason`. Same grep result: **only the portal reads them.** A
workspace that switches on "require voucher approval" changes nothing
server-side. `requireVoidReason` likewise — the void endpoint takes no reason.

These are **fail-open policy switches**, the category CLAUDE.md invariant #4
exists to prevent.

### 1.4 Workflow stamps — partial and inconsistent

| Table | `created_by` | `reviewed_by` / `approved_by` | Transition map |
|---|---|---|---|
| `journal_entries` | ✅ | ❌ none | ✅ `JOURNAL_TRANSITIONS` |
| `vouchers` | ✅ | ❌ none | ✅ `VOUCHER_TRANSITIONS` |
| `billing_statements` | ✅ | ✅ free-text, portal-set | ❌ free-text status |
| `service_invoices` | ✅ | ✅ free-text, portal-set | ❌ (M2 added `ISSUABLE_STATUSES`) |
| `collections` | ✅ | ❌ (`posted_by` only) | ❌ (M2 added `POSTABLE_STATUSES`) |

The two documents that actually post to the ledger through a workflow —
vouchers and journal entries — are the two with **no approver stamp at all**.
`reviewed_by`/`approved_by` on the AR documents are free-text strings written by
the client, not FKs to `app_users`, so they are decorative too.

### 1.5 Where enforcement is missing — the summary

| # | Gap | Severity |
|---|---|---|
| G1 | Self-approval unblocked on every document type | **critical** |
| G2 | `approval_routing` never consulted by the API | **critical** |
| G3 | No audit trail of any status change, anywhere | **critical** |
| G4 | `module_policies.requireVoucherApproval` unenforced (fail-open) | high |
| G5 | Delegations configured but ignored | high |
| G6 | Rejections record no reason for vouchers / JEs | medium |
| G7 | AR `/issue` and `/post` have no maker-checker at all | medium |
| G8 | Authority cannot vary by document type or amount | medium |

---

## 2. The enforcement design

### 2.1 One chokepoint: `assertAuthority()`

Every governed transition routes through a single function, mirroring how
`postJournalEntryCore()` is the one ledger writer:

```ts
assertAuthority(tx, {
  orgId, actor: { userId, email, role },
  documentType,          // 'voucher' | 'journal_entry' | 'service_invoice' | 'collection'
  action,                // 'submit' | 'verify' | 'approve' | 'reject' | 'post' | 'void' | 'issue'
  document: { id, no, createdBy, status },
}) → { granted: true, basis } | throws AuthorityError
```

Four layers, evaluated in order. **Each can only narrow, never widen.**

**Layer 1 — role floor.** Unchanged from today. You must hold a role capable of
the action. This is the existing behaviour and remains the outer bound.

**Layer 2 — segregation of duties.** `actor.userId ≠ document.createdBy` for
`verify`, `approve` and `post`. Absolute; no configuration relaxes it for
`approve`. This alone closes G1 and is the single highest-value change in M3.

The one sanctioned exception is the *verification* step, and only through the
route's existing `autoBypass` flag — which the Settings UI already sets when
maker and verifier are the same person. Note what that means: `autoBypass`
**skips** verification, it does not let the maker verify their own document. The
document moves `for_verification → verified` with `authority_basis =
'auto_bypass'` recorded and **no actor credited**, which is honest. It never
permits self-approval.

**Layer 3 — routing.** If a route exists for the document type, the actor must be
the named party for that action, **or** an active delegate of them. If no route
exists, fall through to the role floor — see §5 Q1, this is a decision for you.

**Layer 4 — policy.** `module_policies` flags are enforced where they exist:
`requireVoucherApproval` blocks the `pending → approved` shortcut,
`requireVoidReason` makes `remarks` mandatory on void.

### 2.2 How `approval_routing` becomes authoritative

Keeping the jsonb store, because the Settings screen already round-trips it and
a storage change would break authoring for no correctness gain. What changes:

1. **A strict schema.** `operations.ts:107` currently types it
   `z.record(z.unknown()).nullable()` — literally anything saves. Replaced with a
   real `zApprovalRouting` (routes, delegates, enum'd document types, email
   format, date ordering). Garbage stops being storable, which matters once the
   API depends on it.

2. **Referential validation on save.** Every `makerEmail` / `verifierEmail` /
   `approverEmail` / delegate email must resolve to an `app_users` row **in this
   org**. Today you can name `nobody@example.com` as approver and the save
   succeeds. That becomes a 400 naming the unknown address.

3. **A canonical document-type vocabulary.** The portal uses display labels
   (`Vouchers`, `Check Voucher`, `Journal`); the API uses internal types
   (`payment`, `check`, `journal_entry`). A single mapping module owns the
   translation, so a rename in either place is a compile error rather than a
   silently unmatched route.

4. **Read at decision time, inside the transaction.** Not cached — an approval is
   rare and correctness beats a saved millisecond. The settings row is read in
   the same `withOrgContext` transaction as the transition, so a routing change
   mid-flight cannot produce a split decision.

5. **Delegates honoured.** A delegate acts for their delegator when
   `isActive` **and** the transition date falls within `[fromDate, toDate]`
   (open-ended when blank) **and** the document type is listed. Recorded as
   `authority_basis = 'delegate:<delegator-email>'`, so the history shows both
   the human who clicked and the authority they borrowed.

**Routing can only narrow authority.** It never grants an action the role floor
denies. That makes it monotonically safe to switch on: configuring a route can
never accidentally expand someone's powers.

### 2.3 Per-document authority replaces coarse role checks

The five workspace roles stay — they become the *floor*, not the whole answer:

| | Today | With M3 |
|---|---|---|
| Who may approve a voucher | anyone with poster/approver/admin | the route's `approverEmail` (or their active delegate) who is **not** the maker |
| Who may verify | anyone with verifier/poster/approver/admin | the route's `verifierEmail`, not the maker |
| Which documents | all types identically | per `documentType` route |
| Record | none | one immutable `workflow_events` row per transition |

**Not proposed:** amount-threshold tiers ("over ₱1M needs two approvers"). The
data model has no place for it and the Settings UI has no field. Genuinely
useful, genuinely a later milestone — flagged so it is not assumed.

---

## 3. The immutable workflow-history table

```sql
CREATE TABLE workflow_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- What moved. document_no is denormalised on purpose: the history must stay
  -- readable even if the source row is later cancelled or renumbered.
  document_type  text        NOT NULL,
  document_id    uuid        NOT NULL,
  document_no    text,

  -- Who moved it. Email and role are SNAPSHOTS: an audit trail that changes
  -- when someone is later promoted or offboarded is not an audit trail.
  actor_id       text        NOT NULL REFERENCES app_users(id),
  actor_email    text        NOT NULL,
  actor_role     text        NOT NULL,

  -- What happened.
  action         text        NOT NULL,   -- submit|verify|approve|reject|post|void|issue|cancel
  from_status    text,                   -- null on the create event
  to_status      text        NOT NULL,
  remarks        text,                   -- mandatory on reject (and on void, per policy)

  -- Why it was allowed. 'route' | 'delegate:<email>' | 'auto_bypass'
  -- | 'role_fallback' | 'admin_override'
  authority_basis text       NOT NULL,

  -- The ledger consequence, when there was one.
  journal_entry_id uuid,

  occurred_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_events_remarks_on_reject_chk
    CHECK (action <> 'reject' OR (remarks IS NOT NULL AND length(btrim(remarks)) > 0))
);

CREATE INDEX workflow_events_org_doc_idx  ON workflow_events (org_id, document_type, document_id, occurred_at);
CREATE INDEX workflow_events_org_actor_idx ON workflow_events (org_id, actor_id, occurred_at DESC);
CREATE INDEX workflow_events_org_time_idx  ON workflow_events (org_id, occurred_at DESC);
```

### Append-only, enforced three ways

**1. A trigger**, mirroring `trg_entry_immutable` (`0000_init.sql:171`):

```sql
CREATE OR REPLACE FUNCTION prevent_workflow_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow_events is append-only; history cannot be changed or deleted.'
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER trg_workflow_event_immutable
  BEFORE UPDATE OR DELETE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION prevent_workflow_event_mutation();
```

**2. Grants that omit the verbs.** Every other tenant table gets
`SELECT, INSERT, UPDATE, DELETE`. This one deliberately does not:

```sql
GRANT SELECT, INSERT ON workflow_events TO sentire_books_app;
```

The API role is *incapable* of rewriting history, so a bug cannot do it either.
This is a deliberate deviation from the house pattern and I want it flagged in
review rather than silently copied over later.

**3. RLS**, same as every tenant table:

```sql
ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workflow_events
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
```

Integration-tested as `sentire_books_app` (invariant #3), including a test that
asserts UPDATE and DELETE both fail — one on the grant, one on the trigger.

`verify-ledger.sql` gains a tenth check: **workflow history is append-only and
its trigger is present**, so a restored backup proves the audit trail survived
rather than merely that its rows came back.

### Not a `journal_entries` replacement

Deliberately separate from the ledger. The ledger records *what the books say*;
this records *who decided it*. A reversal already tells you an entry was undone —
`workflow_events` tells you who authorised it and why.

---

## 4. Hook points

One transaction per transition: authority check, state change, ledger effect and
history row all commit together or none do.

| Endpoint | Action(s) | Ledger effect | New behaviour |
|---|---|---|---|
| `POST /vouchers/:id/status` | submit · verify · approve · reject | `approve` posts the JE | authority + history; **self-approval blocked** |
| `POST /vouchers/:id/void` | void | reverses | authority + history; remarks per `requireVoidReason` |
| `POST /journal-entries/:id/status` | submit · clear · post · reject | `posted` | authority + history; **self-posting blocked** |
| `POST /service-invoices/:id/issue` | issue | posts T1/T2/T3 | authority + history |
| `POST /service-invoices/:id/cancel` | cancel | reverses | authority + history |
| `POST /collections/:id/post` | post | posts C1 (+ Sec. 116) | authority + history |
| `POST /collections/:id/void` | void | reverses both | authority + history |

Creation events (`create`/`draft`) are recorded too, so every document's history
starts with who made it — otherwise "not the maker" has nothing to point at for
documents created before M3.

**Loans and Fixed Assets** are deferred and hidden. Their booking endpoints get
history recording (cheap, and it means the trail is complete if they are ever
un-deferred) but **no new gating** — they already require `requireWorkflowPoster`
and adding routing to a hidden module is work with no user.

---

## 5. Scope

### In

| Document | Why |
|---|---|
| **Journal entries** | direct ledger writes; the highest-authority action in the system |
| **Vouchers** (payment, check, and the rest) | the main disbursement path; where the self-approval hole is most exploitable |
| **Service invoices** | `/issue` posts revenue and AR (M2.1) |
| **Collections** | `/post` moves cash and settles receivables (M2.2) |

### Out for MVP

| Excluded | Reason |
|---|---|
| **Billing statements** | presentation-only, never posted (M2 decision) — nothing to govern |
| **Payment schedules · schedule payments** | intent records; the money moves through a voucher, which *is* governed |
| **Weekly projections · disbursement reports** | planning and batching artefacts, no ledger effect |
| **Loans · Fixed assets** | deferred modules; history recorded, gating not added |
| **Contacts, COA, tax rates and other reference data** | master data. Real audit need, different shape (field-level diffs) — a later milestone, not this one |
| **Amount-threshold tiers / multi-approver** | no data model, no UI field. §2.3 |
| **Email or push notification of pending approvals** | the Approvals inbox already surfaces them; notifications are their own milestone |
| **Portal UI for the history timeline** | M3 delivers the API and the record; the screen follows |

---

## 6. Decisions I need from you

| # | Question | My recommendation |
|---|---|---|
| **1** | **When no route is configured for a document type**, fall back to the role check (today's behaviour, recorded as `role_fallback`), or refuse the action outright? | **Role fallback.** Fail-closed here would lock your live workspace out of approving anything the moment M3 ships, since no routes exist for AR documents at all. Segregation of duties (Layer 2) still applies, so the dangerous hole closes either way. Settings shows a warning banner listing ungoverned document types. |
| **2** | **May an `admin` override routing** as break-glass? | **Yes, recorded as `admin_override`** and surfaced distinctly in history. A control you cannot bypass in an emergency gets bypassed by sharing credentials, which is worse. If you prefer no override, say so — it is a one-line change. |
| **3** | **Is self-approval blocked absolutely**, or relaxable per route? | **Absolute for `approve` and `post`.** Verification may be skipped via the existing `autoBypass`, credited to no one. This is the invariant M3 exists to establish. |
| **4** | **Enforce `module_policies.requireVoucherApproval` and `requireVoidReason`?** | **Yes.** They are fail-open switches today. |
| **5** | **Do AR documents get the full maker-checker chain**, or history + self-approval block only for MVP? | **History + segregation of duties only.** Invoices go Draft → Issued in one step; inserting a verify/approve chain changes the AR workflow and the portal screens materially. Worth doing deliberately, not as a side effect of M3. |
| **6** | **Backfill history for existing documents?** | **A single synthetic `migrated` event per existing document**, marked `authority_basis = 'pre_m3'`, so every document has a history origin and the timeline never starts mid-story. No invented actors — `actor_id` is the document's `created_by`, which is real. |
| **7** | The routing UI offers `Weekly Projections` and `Disbursements`, both **out of scope** (§5). Leave them configurable-but-unenforced, or hide them? | **Leave them,** with the Settings warning from Q1 marking them ungoverned. Removing configuration people may already have set is worse than labelling it. |

Questions 1–7 are all answerable from your side. None requires database access.

---

## 7. Task breakdown

One task, one PR, acceptance check, production delta where a migration lands.

| Task | Deliverable | Acceptance check |
|---|---|---|
| **M3.1** | `workflow_events` table + append-only trigger + RLS + restricted grants; recording wired into **voucher** and **journal-entry** transitions | Integration test as `sentire_books_app`: a transition writes exactly one event with correct from→to; **UPDATE fails on the grant, DELETE fails on the trigger**; RLS blocks cross-org reads. `verify-ledger.sql` gains check #10. |
| **M3.2** | **Segregation of duties** — `assertAuthority` layers 1–2, wired into all seven hook points | The headline case: one user creates a voucher and is refused at verify **and** at approve with 403 `self_approval_blocked`; a second user succeeds. Same for JE post, invoice issue, collection post. Trial balance unchanged — no ledger effect. |
| **M3.3** | **Routing authoritative** — strict `zApprovalRouting`, referential validation on save, canonical doc-type mapping, layers 3–4 incl. delegates | A named approver succeeds; a role-holding non-approver gets 403 `not_authorized_for_document`; an in-window delegate succeeds and records `delegate:<email>`; an out-of-window one is refused. Saving a route naming an unknown email is a 400. |
| **M3.4** | **Policy enforcement** — `requireVoucherApproval`, `requireVoidReason`; mandatory reject remarks | Policy on ⇒ shortcut refused; policy off ⇒ allowed. Reject without remarks is a 400 *and* the DB CHECK rejects a direct insert. |
| **M3.5** | **History read API** — `GET /:documentType/:id/history` and an org-wide `GET /reports/workflow-history?from=&to=&actor=&documentType=` | Full chain returned oldest-first for a document driven end to end; org-scoped; no truncation (the M2.5 lesson). |

**M3.1 must land first** — every later task records into it. **M3.2 is the one
that closes the finding in §0** and is independently valuable if you want to stop
there.

Ledger-touching: none of M3 changes what posts, only who may cause it. I will
still prove the trial balance reconciles to the centavo after M3.2 and M3.3,
since both sit directly in the posting path.

**Production deltas:** M3.1 (`workflow_events`) and M3.3 (any `org_settings`
validation backfill) each ship a `livedbdelta`. M3.1's must precede its deploy —
the API writes to a table that would not exist.

---

## 8. What I am not building

- **Amount thresholds, multi-approver panels, escalation timers.** §2.3.
- **Master-data audit** (contacts, chart of accounts, tax rates). Field-level
  diffs are a different shape from status transitions; conflating them would make
  `workflow_events` serve two masters badly.
- **Notifications.** §5.
- **Portal history timeline UI.** API first; screen follows.
- **Changing the five workspace roles.** They stay the floor. M3 adds precision
  above them, it does not renumber them.
- **AI layer, cross-tenant admin, real bank reconciliation.** Still deferred.

---

I will not start M3.1 until you approve this and answer §6.
