/**
 * API client for the Sentire Books Hono backend — the replacement for direct
 * Firestore access as this app is re-platformed onto Postgres.
 *
 * A Books access token (from POST /auth/password) is sent as
 * `Authorization: Bearer`, and the active workspace as `x-org-id`. On a 401 we
 * bounce back to the login screen. Every module calls these helpers instead of
 * talking to Firestore; module-specific calls are added here as each screen is
 * rewired.
 */
const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

let _accessToken = null;
export function setAccessToken(token) {
  _accessToken = token;
}

// Active workspace (an identity may belong to several). Sent as `x-org-id`.
let _orgId = null;
export function setActiveOrg(orgId) {
  _orgId = orgId;
}

// Registered by the auth provider; mints a fresh JWT (or redirects to login).
let _refresher = null;
export function setTokenRefresher(fn) {
  _refresher = fn;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(`API ${status}`);
    this.status = status;
    this.body = body;
  }
  get detail() {
    const b = this.body || {};
    return b.detail ?? b.error ?? `Request failed (${this.status})`;
  }
}

export async function apiFetch(path, init, retried = false) {
  const headers = { 'content-type': 'application/json' };
  if (_accessToken) headers['authorization'] = `Bearer ${_accessToken}`;
  if (_orgId) headers['x-org-id'] = _orgId;
  if (init && init.headers) Object.assign(headers, init.headers);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401 && !retried && _accessToken && _refresher) {
    const fresh = await _refresher();
    if (fresh) {
      _accessToken = fresh;
      return apiFetch(path, init, true);
    }
  }

  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── auth / workspace ─────────────────────────────────────────────────────────
export const getMe = () => apiFetch('/auth/me');
export const listWorkspaces = () => apiFetch('/auth/workspaces');
export const signInWithPassword = (email, password) =>
  apiFetch('/auth/password', { method: 'POST', body: JSON.stringify({ email, password }) });

// ── core ledger (backend already exists — used in Phase 1) ───────────────────
function periodQuery(p) {
  const s = new URLSearchParams();
  if (p && p.from) s.set('from', p.from);
  if (p && p.to) s.set('to', p.to);
  const q = s.toString();
  return q ? `?${q}` : '';
}

export const listAccounts = () => apiFetch('/accounts').then((r) => r.accounts);
export const createAccount = (payload) =>
  apiFetch('/accounts', { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.account);
export const updateAccount = (id, payload) =>
  apiFetch(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(payload) }).then((r) => r.account);
export const deleteAccount = (id) => apiFetch(`/accounts/${id}`, { method: 'DELETE' });
export const importAccounts = (accounts) =>
  apiFetch('/accounts/import', { method: 'POST', body: JSON.stringify({ accounts }) });
export const listContacts = (type) =>
  apiFetch(`/contacts${type ? `?type=${type}` : ''}`).then((r) => r.contacts);
export const createContact = (payload) =>
  apiFetch('/contacts', { method: 'POST', body: JSON.stringify(payload) }).then((r) => r.contact);
export const updateContact = (id, payload) =>
  apiFetch(`/contacts/${id}`, { method: 'PUT', body: JSON.stringify(payload) }).then((r) => r.contact);
export const deleteContact = (id) => apiFetch(`/contacts/${id}`, { method: 'DELETE' });
export const listJournalEntries = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') s.set(k, v);
  const q = s.toString();
  return apiFetch(`/journal-entries${q ? `?${q}` : ''}`).then((r) => r.entries);
};
export const getJournalEntry = (id) => apiFetch(`/journal-entries/${id}`);
export const createJournalEntry = (payload) =>
  apiFetch('/journal-entries', { method: 'POST', body: JSON.stringify(payload) });
export const updateJournalEntry = (id, payload) =>
  apiFetch(`/journal-entries/${id}`, { method: 'PUT', body: JSON.stringify(payload) }).then((r) => r.entry);
export const deleteJournalEntry = (id) => apiFetch(`/journal-entries/${id}`, { method: 'DELETE' });
export const transitionJournalEntry = (id, to) =>
  apiFetch(`/journal-entries/${id}/status`, { method: 'POST', body: JSON.stringify({ to }) }).then((r) => r.entry);
export const reverseJournalEntry = (id) =>
  apiFetch(`/journal-entries/${id}/reverse`, { method: 'POST', body: JSON.stringify({}) });
export const listVouchers = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') s.set(k, v);
  const q = s.toString();
  return apiFetch(`/vouchers${q ? `?${q}` : ''}`).then((r) => r.vouchers);
};
export const getVoucher = (id) => apiFetch(`/vouchers/${id}`);
export const createVoucher = (payload) =>
  apiFetch('/vouchers', { method: 'POST', body: JSON.stringify(payload) });
export const createVoucherDraft = (payload) =>
  apiFetch('/vouchers', { method: 'POST', body: JSON.stringify({ ...payload, draft: true }) });
export const updateVoucher = (id, payload) =>
  apiFetch(`/vouchers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }).then((r) => r.voucher);
export const deleteVoucher = (id) => apiFetch(`/vouchers/${id}`, { method: 'DELETE' });
export const transitionVoucher = (id, to) =>
  apiFetch(`/vouchers/${id}/status`, { method: 'POST', body: JSON.stringify({ to }) });
export const voidVoucher = (id) =>
  apiFetch(`/vouchers/${id}/void`, { method: 'POST', body: JSON.stringify({}) });
export const getTrialBalance = (p) => apiFetch(`/reports/trial-balance${periodQuery(p)}`);
export const getProfitAndLoss = (p) => apiFetch(`/reports/profit-and-loss${periodQuery(p)}`);
// ── users (admin-only list; callers fall back to emails on 403) ──────────────
export const listUsers = () => apiFetch('/users').then((r) => r.users);
export const inviteUser = (p) =>
  apiFetch('/users', { method: 'POST', body: JSON.stringify(p) }).then((r) => r.user);
export const updateUser = (id, p) =>
  apiFetch(`/users/${id}`, { method: 'PUT', body: JSON.stringify(p) }).then((r) => r.user);
export const deleteUser = (id) => apiFetch(`/users/${id}`, { method: 'DELETE' });
export const setUserPassword = (id, password) =>
  apiFetch(`/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) });

// ── data admin (export / reset / restore — admin only) ──────────────────────
export const exportWorkspaceData = () => apiFetch('/settings/data/export');
// Destructive. `confirm` must be the caller's own workspace code — the API
// rejects anything else, so a reset can't be fired at the wrong tenant.
export const resetWorkspaceData = (confirm) =>
  apiFetch('/settings/data/reset', { method: 'POST', body: JSON.stringify({ confirm }) });
export const importWorkspaceData = (snapshot) =>
  apiFetch('/settings/data/import', { method: 'POST', body: JSON.stringify(snapshot) });

// ── document counters (admin inspection/override) ────────────────────────────
export const listCounters = () => apiFetch('/settings/counters').then((r) => r.counters);
export const overrideCounter = (periodKey, seq) =>
  apiFetch(`/settings/counters/${encodeURIComponent(periodKey)}`, { method: 'PUT', body: JSON.stringify({ seq }) }).then((r) => r.counter);

// ── settings / checkbooks / checks / disbursements ───────────────────────────
export const getSettings = () => apiFetch('/settings');
export const updateSettings = (payload) =>
  apiFetch('/settings', { method: 'PUT', body: JSON.stringify(payload) });

export const listCheckbooks = () => apiFetch('/checkbooks').then((r) => r.checkbooks);
export const createCheckbook = (p) =>
  apiFetch('/checkbooks', { method: 'POST', body: JSON.stringify(p) }).then((r) => r.checkbook);
export const updateCheckbook = (id, p) =>
  apiFetch(`/checkbooks/${id}`, { method: 'PUT', body: JSON.stringify(p) }).then((r) => r.checkbook);
export const deleteCheckbook = (id) => apiFetch(`/checkbooks/${id}`, { method: 'DELETE' });

export const listChecks = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') s.set(k, v);
  const q = s.toString();
  return apiFetch(`/checks${q ? `?${q}` : ''}`).then((r) => r.checks);
};
export const createChecks = (checks) =>
  apiFetch('/checks', { method: 'POST', body: JSON.stringify({ checks }) }).then((r) => r.checks);
export const updateCheck = (id, p) =>
  apiFetch(`/checks/${id}`, { method: 'PUT', body: JSON.stringify(p) }).then((r) => r.check);
export const setCheckStatus = (id, status, opts) =>
  apiFetch(`/checks/${id}/status`, { method: 'POST', body: JSON.stringify({ status, ...(opts || {}) }) }).then((r) => r.check);
export const deleteCheck = (id) => apiFetch(`/checks/${id}`, { method: 'DELETE' });

export const listDisbursementReports = () =>
  apiFetch('/disbursement-reports').then((r) => r.reports);
export const getDisbursementReport = (id) =>
  apiFetch(`/disbursement-reports/${id}`).then((r) => r.report);
export const createDisbursementReport = (p) =>
  apiFetch('/disbursement-reports', { method: 'POST', body: JSON.stringify(p) }).then((r) => r.report);
export const updateDisbursementReport = (id, p) =>
  apiFetch(`/disbursement-reports/${id}`, { method: 'PUT', body: JSON.stringify(p) }).then((r) => r.report);
export const setDisbursementStatus = (id, status, reason) =>
  apiFetch(`/disbursement-reports/${id}/status`, { method: 'POST', body: JSON.stringify({ status, ...(reason ? { reason } : {}) }) }).then((r) => r.report);
export const deleteDisbursementReport = (id) =>
  apiFetch(`/disbursement-reports/${id}`, { method: 'DELETE' });

// ── tax + bank reference data ────────────────────────────────────────────────
const crud = (base, plural, singular) => ({
  list: () => apiFetch(base).then((r) => r[plural]),
  create: (p) => apiFetch(base, { method: 'POST', body: JSON.stringify(p) }).then((r) => r[singular]),
  update: (id, p) => apiFetch(`${base}/${id}`, { method: 'PUT', body: JSON.stringify(p) }).then((r) => r[singular]),
  remove: (id) => apiFetch(`${base}/${id}`, { method: 'DELETE' }),
});
export const taxRatesApi = crud('/tax-rates', 'rates', 'rate');
export const taxGroupsApi = crud('/tax-groups', 'groups', 'group');
export const purposeCategoriesApi = crud('/purpose-categories', 'categories', 'category');
export const paymentTermsApi = crud('/payment-terms', 'terms', 'term');
export const bankBalancesApi = crud('/bank-balances', 'balances', 'balance');
export const bankTransactionsApi = crud('/bank-transactions', 'transactions', 'transaction');
export const bankReconciliationsApi = crud('/bank-reconciliations', 'reconciliations', 'reconciliation');

// ── loans / assets / projections / credit lines ─────────────────────────────
export const loansApi = crud('/loans', 'loans', 'loan');
export const bookLoan = (id, opts) =>
  apiFetch(`/loans/${id}/book`, { method: 'POST', body: JSON.stringify(opts || {}) });
export const unbookLoan = (id) =>
  apiFetch(`/loans/${id}/unbook`, { method: 'POST', body: JSON.stringify({}) });
// Record a payment: FM originates the disbursement instrument (Payment Voucher,
// or Check Voucher + registry entry for PDC) and links it to the loan payment.
export const payLoan = (id, opts) =>
  apiFetch(`/loans/${id}/pay`, { method: 'POST', body: JSON.stringify(opts || {}) });
// Register a loan and post its origination entry atomically (booking is automatic).
export const registerLoan = (payload) =>
  apiFetch('/loans/register', { method: 'POST', body: JSON.stringify(payload) });
// Cancel a loan (reverses its ledger entry, marks it Cancelled). Loans are never deleted.
export const cancelLoan = (id) =>
  apiFetch(`/loans/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
// Reconcile the loan sub-ledger against the GL Loans Payable control account.
export const loanReconciliation = () => apiFetch('/loans/reconciliation');
export const loanPaymentsApi = crud('/loan-payments', 'payments', 'payment');
export const assetTypesApi = crud('/asset-types', 'types', 'type');
export const fixedAssetsApi = crud('/fixed-assets', 'assets', 'asset');
// Register an asset and post its acquisition entry atomically (booking is automatic).
export const registerAsset = (payload) =>
  apiFetch('/fixed-assets/register', { method: 'POST', body: JSON.stringify(payload) });
// Book an existing (unbooked) asset; cancel reverses its entry and marks it Cancelled.
export const bookAsset = (id, opts) =>
  apiFetch(`/fixed-assets/${id}/book`, { method: 'POST', body: JSON.stringify(opts || {}) });
export const cancelAsset = (id) =>
  apiFetch(`/fixed-assets/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
export const assetInstallmentPaymentsApi = crud('/asset-installment-payments', 'payments', 'payment');
export const assetDeprPostingsApi = crud('/asset-depr-postings', 'postings', 'posting');
export const weeklyProjectionsApi = crud('/weekly-projections', 'projections', 'projection');
export const creditLinesApi = crud('/credit-lines', 'creditLines', 'creditLine');

// ── billing / accounts receivable ────────────────────────────────────────────
export const billingStatementsApi = crud('/billing-statements', 'statements', 'statement');
export const serviceInvoicesApi = crud('/service-invoices', 'invoices', 'invoice');
export const collectionsApi = crud('/collections', 'collections', 'collection');
export const paymentSchedulesApi = crud('/payment-schedules', 'schedules', 'schedule');
export const schedulePaymentsApi = crud('/schedule-payments', 'payments', 'payment');

/** Issue a draft invoice — posts its revenue entry (T1/T2/T3). */
export const issueInvoice = (id, opts) =>
  apiFetch(`/service-invoices/${id}/issue`, { method: 'POST', body: JSON.stringify(opts || {}) });
/**
 * SEAM (Track B B2). Preview the journal entry an issuance WOULD post, without
 * posting it — so the screen can show DR/CR lines and the tax split before the
 * user commits. The server MUST compute this (no browser-side VAT arithmetic).
 *
 * This endpoint does NOT exist on main yet; until Track A ships
 * `POST /service-invoices/:id/issue-preview`, this call 404s and the preview
 * panel renders its honest "unavailable" state rather than fabricating figures.
 * Contract specified verbatim in the B2 report (A1 ii).
 */
export const previewInvoiceIssuance = (id, opts) =>
  apiFetch(`/service-invoices/${id}/issue-preview`, { method: 'POST', body: JSON.stringify(opts || {}) });
/** Cancel an invoice — reverses its issuance entry. Never deleted. */
export const cancelInvoice = (id) =>
  apiFetch(`/service-invoices/${id}/cancel`, { method: 'POST', body: '{}' });
/** Post a collection against one or more invoices. */
export const postCollection = (id, opts) =>
  apiFetch(`/collections/${id}/post`, { method: 'POST', body: JSON.stringify(opts || {}) });
/** Void a posted collection — reverses its entries and rolls the AR back. */
export const voidCollection = (id) =>
  apiFetch(`/collections/${id}/void`, { method: 'POST', body: '{}' });
/** AR sub-ledger vs GL control — the reconciliation tile. */
export const arReconciliation = () => apiFetch('/collections/ar-reconciliation');
/** AR aging, bucketed Current / 1–30 / 31–60 / 61–90 / 90+. */
export const arAging = (asOf) =>
  apiFetch(`/service-invoices/aging${asOf ? `?asOf=${asOf}` : ''}`);

/**
 * Tax registry — every period, both sides, in ONE request.
 *
 * Replaces the old client-side derivation, which hydrated only the 50 most
 * recent Payment/Check vouchers (one request each) and had no sales side at
 * all. Omit the range to cover the whole ledger.
 */
export const getTaxRegistry = ({ from, to } = {}) => {
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  return apiFetch(`/reports/tax-registry${qs ? `?${qs}` : ''}`);
};

export const getGeneralLedger = (p) => apiFetch(`/reports/general-ledger${periodQuery(p)}`);
export const getIncomeStatement = (p) => apiFetch(`/reports/income-statement${periodQuery(p)}`);
export const getBalanceSheet = (asOf) =>
  apiFetch(`/reports/balance-sheet${asOf ? `?asOf=${asOf}` : ''}`);
