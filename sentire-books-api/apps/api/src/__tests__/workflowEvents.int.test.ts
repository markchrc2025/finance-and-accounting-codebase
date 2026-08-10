/**
 * workflow_events (M3.2) — real Postgres, RLS-bound as `sentire_books_app`.
 * Skipped unless DATABASE_URL is set.
 *
 * Two INDEPENDENT defences against a rewritten history:
 *   1. The GRANT — the app role has SELECT + INSERT only (T3), tested as the app
 *      role.
 *   2. The write-once TRIGGER — tested as the OWNER, because the grant blocks the
 *      app role's UPDATE/DELETE before any trigger can fire. A UNIQUE index is
 *      not immutability; the trigger is the guarantee.
 *
 * No enforcement is exercised here — nothing reads created_by, nothing writes an
 * event through a handler. This unit is table + RLS + trigger only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { withOrgContext, DEMO_ORG_ID, DEMO_ADMIN_ID, DEMO_ADMIN_EMAIL } from "@sentire-books/db";

const RUN = !!process.env.DATABASE_URL;
const ctx = { userId: DEMO_ADMIN_ID, orgId: DEMO_ORG_ID, role: "admin" as const };
const OTHER_ORG = "00000000-0000-0000-0000-0000000000fe";
const OTHER_ID = "00000000-0000-0000-0000-0000000000ee";

let owner: ReturnType<typeof postgres>;

/** Insert a valid event AS THE APP ROLE, returning the stored row. */
async function insertEvent(over: Record<string, unknown> = {}) {
  const e = {
    documentType: "voucher",
    documentId: "00000000-0000-0000-0000-0000000000d1",
    documentNo: null as string | null,
    actorId: DEMO_ADMIN_ID,
    actorEmail: DEMO_ADMIN_EMAIL,
    actorRole: "admin",
    action: "approve",
    fromStatus: "for_approval" as string | null,
    toStatus: "approved",
    remarks: null as string | null,
    authorityBasis: "route",
    journalEntryId: null as string | null,
    accountingDate: "2026-08-10",
    ...over,
  };
  const rows = (await withOrgContext(ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO workflow_events
        (org_id, document_type, document_id, document_no, actor_id, actor_email,
         actor_role, action, from_status, to_status, remarks, authority_basis,
         journal_entry_id, accounting_date)
      VALUES
        (${DEMO_ORG_ID}, ${e.documentType}, ${e.documentId}, ${e.documentNo}, ${e.actorId},
         ${e.actorEmail}, ${e.actorRole}, ${e.action}, ${e.fromStatus}, ${e.toStatus},
         ${e.remarks}, ${e.authorityBasis}, ${e.journalEntryId}, ${e.accountingDate})
      RETURNING id, event_at, accounting_date, document_no`),
  )) as unknown as Array<{ id: string; event_at: string; accounting_date: string; document_no: string | null }>;
  return rows[0]!;
}

const countById = (id: string, orgId = DEMO_ORG_ID) =>
  withOrgContext({ userId: DEMO_ADMIN_ID, orgId, role: "admin" as const }, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM workflow_events WHERE id = ${id}`),
  ).then((r) => (r as unknown as Array<{ n: number }>)[0]!.n);

describe.skipIf(!RUN)("M3.2 — workflow_events", () => {
  const saved = { secret: process.env.AUTH_JWT_SECRET, bypass: process.env.AUTH_DEV_BYPASS };

  beforeAll(() => {
    delete process.env.AUTH_JWT_SECRET;
    process.env.AUTH_DEV_BYPASS = "true";
    owner = postgres(process.env.DATABASE_URL_DIRECT!, { max: 2, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    // Owner-only cleanup: the append-only trigger fires on UPDATE/DELETE, not
    // TRUNCATE, and the app role has no TRUNCATE privilege — so only the owner
    // can reset the table between runs.
    await owner`TRUNCATE workflow_events`.catch(() => {});
    await owner.end();
    if (saved.secret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = saved.secret;
    if (saved.bypass === undefined) delete process.env.AUTH_DEV_BYPASS;
    else process.env.AUTH_DEV_BYPASS = saved.bypass;
  });

  // ── T1: the TRIGGER — write-once, as the owner ──────────────────────────────
  it("a set value cannot be changed or nulled, the row cannot be deleted, but NULL→value is allowed", async () => {
    // from_status is set, document_no is NULL — so we can test both directions.
    const row = await insertEvent({ fromStatus: "for_approval", documentNo: null });

    // value → different  ⇒ rejected
    await expect(owner`UPDATE workflow_events SET actor_id = ${OTHER_ID} WHERE id = ${row.id}`).rejects.toThrow();
    // value → NULL (on a genuinely nullable column that HAS a value) ⇒ rejected
    await expect(owner`UPDATE workflow_events SET from_status = NULL WHERE id = ${row.id}`).rejects.toThrow();
    // DELETE ⇒ rejected
    await expect(owner`DELETE FROM workflow_events WHERE id = ${row.id}`).rejects.toThrow();

    // NULL → value (document_no was NULL) ⇒ permitted
    await owner`UPDATE workflow_events SET document_no = 'PV-1' WHERE id = ${row.id}`;
    const [after] = await owner`SELECT actor_id, from_status, document_no FROM workflow_events WHERE id = ${row.id}`;
    expect(after!.document_no).toBe("PV-1");
    expect(after!.actor_id).toBe(DEMO_ADMIN_ID); // unchanged
    expect(after!.from_status).toBe("for_approval"); // unchanged
  });

  // ── T2: RLS — cross-org SELECT returns nothing ──────────────────────────────
  it("cross-org SELECT returns nothing (RLS deny-by-default)", async () => {
    const row = await insertEvent();
    expect(await countById(row.id, DEMO_ORG_ID)).toBe(1); // visible in its own org
    expect(await countById(row.id, OTHER_ORG)).toBe(0); // invisible from another org
  });

  // ── T3: the GRANT — app role has no UPDATE or DELETE ────────────────────────
  it("the app role has no UPDATE or DELETE privilege (independent of the trigger)", async () => {
    const row = await insertEvent();
    await expect(
      withOrgContext(ctx, (tx) => tx.execute(sql`UPDATE workflow_events SET actor_role = 'x' WHERE id = ${row.id}`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withOrgContext(ctx, (tx) => tx.execute(sql`DELETE FROM workflow_events WHERE id = ${row.id}`)),
    ).rejects.toThrow(/permission denied/i);
  });

  // ── T4: no lifetime UNIQUE — a resubmit records a SECOND submit (C1) ─────────
  it("records the same (document, action) pair twice — a rejected-then-resubmitted document", async () => {
    const docId = "00000000-0000-0000-0000-0000000000d4";
    await insertEvent({ documentId: docId, action: "submit", fromStatus: "draft", toStatus: "pending_review" });
    await insertEvent({ documentId: docId, action: "reject", fromStatus: "pending_review", toStatus: "rejected", remarks: "fix the total" });
    const second = await insertEvent({ documentId: docId, action: "submit", fromStatus: "draft", toStatus: "pending_review" });
    expect(second.id).toBeTruthy();
    const n = (await withOrgContext(ctx, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM workflow_events WHERE document_id = ${docId} AND action = 'submit'`),
    )) as unknown as Array<{ n: number }>;
    expect(n[0]!.n).toBe(2);
  });

  // ── T5: both dates populated and independent ────────────────────────────────
  it("carries an independent accounting_date (document period) and event_at (now)", async () => {
    const row = await insertEvent({ accountingDate: "2025-03-15" }); // back-dated document
    expect(String(row.accounting_date).slice(0, 7)).toBe("2025-03");
    const eventYear = new Date(String(row.event_at)).getUTCFullYear();
    expect(eventYear).toBeGreaterThanOrEqual(2026); // calendar time, not the document's period
    expect(String(row.accounting_date).slice(0, 4)).not.toBe(String(eventYear));
  });
});
