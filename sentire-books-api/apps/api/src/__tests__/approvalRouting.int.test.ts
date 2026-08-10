/**
 * Typed approval routing (M3.1) — real Postgres, real settings router, RLS-bound
 * as `sentire_books_app`. Skipped unless DATABASE_URL is set.
 *
 * `org_settings.approval_routing` was an untyped jsonb blob
 * (operations.ts:107 `z.record(z.unknown())`) — literally anything saved. This
 * suite proves the server now PARSES it on write while still accepting the exact
 * shape the Settings screen sends today (the anti-outage guarantee), and reads
 * legacy blobs leniently rather than 500-ing.
 *
 * NO enforcement here: nothing consults routing for a write, and autoBypass is
 * stored but not honored (that is M3.2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  withOrgContext,
  appUsers,
  DEMO_ORG_ID,
  DEMO_ADMIN_ID,
  DEMO_ADMIN_EMAIL,
  type UserRole,
} from "@sentire-books/db";
import { settingsRoutes } from "../routes/settings";

const RUN = !!process.env.DATABASE_URL;
const ctx = { userId: DEMO_ADMIN_ID, orgId: DEMO_ORG_ID, role: "admin" as const };

const app = new Hono();
app.route("/settings", settingsRoutes);

const call = (method: string, body?: unknown, email = DEMO_ADMIN_EMAIL) =>
  app.request("/settings", {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-id": DEMO_ADMIN_ID,
      "x-user-email": email,
      "x-org-id": DEMO_ORG_ID,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const setRole = (role: UserRole) =>
  withOrgContext(ctx, (tx) =>
    tx.update(appUsers).set({ role }).where(and(eq(appUsers.orgId, DEMO_ORG_ID), eq(appUsers.id, DEMO_ADMIN_ID))),
  );

/** The EXACT shape SettingsPage.jsx writes today — all five document-type
 *  labels, an auto-bypass route with a blank verifier, and a delegate window.
 *  Emails are lowercase, as they arrive from the app_users picker. */
const PORTAL_PAYLOAD = {
  routes: [
    { id: "r1", documentType: "Vouchers", makerEmail: "maker@demo.test", verifierEmail: "verifier@demo.test", approverEmail: "approver@demo.test", autoBypass: false },
    { id: "r2", documentType: "Check Voucher", makerEmail: "maker@demo.test", verifierEmail: "", approverEmail: "approver@demo.test", autoBypass: true },
    { id: "r3", documentType: "Journal", makerEmail: "m@demo.test", verifierEmail: "v@demo.test", approverEmail: "a@demo.test", autoBypass: false },
    { id: "r4", documentType: "Weekly Projections", makerEmail: "m@demo.test", verifierEmail: "", approverEmail: "a@demo.test", autoBypass: true },
    { id: "r5", documentType: "Disbursements", makerEmail: "m@demo.test", verifierEmail: "v@demo.test", approverEmail: "a@demo.test", autoBypass: false },
  ],
  delegates: [
    { id: "d1", delegatorEmail: "a@demo.test", delegateEmail: "b@demo.test", documentTypes: ["Vouchers", "Journal"], fromDate: "2026-08-01", toDate: "2026-08-15", isActive: true },
  ],
};

describe.skipIf(!RUN)("M3.1 — typed approval routing", () => {
  const saved = { secret: process.env.AUTH_JWT_SECRET, bypass: process.env.AUTH_DEV_BYPASS };

  beforeAll(async () => {
    delete process.env.AUTH_JWT_SECRET;
    process.env.AUTH_DEV_BYPASS = "true";
    await setRole("admin");
  });

  afterAll(async () => {
    await setRole("admin"); // never leave the demo user demoted
    // Restore the pristine (no org_settings row) state the seed ships.
    await withOrgContext(ctx, (tx) =>
      tx.execute(sql`DELETE FROM org_settings WHERE org_id = ${DEMO_ORG_ID}`),
    );
    if (saved.secret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = saved.secret;
    if (saved.bypass === undefined) delete process.env.AUTH_DEV_BYPASS;
    else process.env.AUTH_DEV_BYPASS = saved.bypass;
  });

  // ── T1: the server now rejects garbage ──────────────────────────────────────
  it("rejects a malformed routing document with 400 and field-level detail", async () => {
    const res = await call("PUT", {
      approvalRouting: { routes: [{ id: "x", documentType: "Vouchers", makerEmail: "not-an-email", approverEmail: "a@b.co" }] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; issues?: Array<{ path: (string | number)[] }> };
    expect(body.error).toBe("validation_error");
    expect(Array.isArray(body.issues) && body.issues.length).toBeTruthy();
    // the path points at the offending field, not a vague top-level error
    expect(JSON.stringify(body.issues)).toContain("makerEmail");
  });

  it("rejects an unknown documentType label", async () => {
    const res = await call("PUT", {
      approvalRouting: { routes: [{ id: "x", documentType: "Nonsense", makerEmail: "a@b.co", approverEmail: "c@d.co" }] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("validation_error");
  });

  // ── T2: THE ANTI-OUTAGE TEST ─────────────────────────────────────────────────
  it("the live portal payload round-trips through PUT then GET unchanged", async () => {
    const put = await call("PUT", { approvalRouting: PORTAL_PAYLOAD });
    expect(put.status, await put.clone().text()).toBe(200);
    expect((await put.json() as { approvalRouting: unknown }).approvalRouting).toEqual(PORTAL_PAYLOAD);

    const get = await call("GET");
    expect(get.status).toBe(200);
    const body = (await get.json()) as { approvalRouting: unknown; approvalRoutingValid?: boolean };
    expect(body.approvalRouting).toEqual(PORTAL_PAYLOAD);
    expect(body.approvalRoutingValid).toBe(true);
  });

  it("accepts and lowercases mixed-case emails", async () => {
    const res = await call("PUT", {
      approvalRouting: { routes: [{ id: "u1", documentType: "Journal", makerEmail: "Maker@Demo.TEST", verifierEmail: "", approverEmail: "Approver@Demo.TEST", autoBypass: true }], delegates: [] },
    });
    expect(res.status).toBe(200);
    const route = (await res.json() as { approvalRouting: { routes: Array<{ makerEmail: string; approverEmail: string }> } }).approvalRouting.routes[0]!;
    expect(route.makerEmail).toBe("maker@demo.test");
    expect(route.approverEmail).toBe("approver@demo.test");
  });

  // ── T3: legacy blobs read leniently ──────────────────────────────────────────
  it("reads a legacy/unrecognised blob without error and flags it unvalidated", async () => {
    await withOrgContext(ctx, (tx) =>
      tx.execute(sql`
        INSERT INTO org_settings (org_id, approval_routing)
        VALUES (${DEMO_ORG_ID}, ${JSON.stringify({ legacyShape: true, whatever: [1, 2, 3] })}::jsonb)
        ON CONFLICT (org_id) DO UPDATE SET approval_routing = EXCLUDED.approval_routing`),
    );
    const res = await call("GET");
    expect(res.status).toBe(200); // never a 500
    const body = (await res.json()) as { approvalRouting: unknown; approvalRoutingValid?: boolean | null };
    expect(body.approvalRouting).toEqual({ legacyShape: true, whatever: [1, 2, 3] });
    expect(body.approvalRoutingValid).toBe(false);
  });

  // ── T4: the admin gate is unchanged ──────────────────────────────────────────
  it("forbids a non-admin PUT /settings", async () => {
    await setRole("maker");
    try {
      const res = await call("PUT", { approvalRouting: PORTAL_PAYLOAD });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: string }).error).toBe("forbidden");
    } finally {
      await setRole("admin");
    }
  });
});
