// NewAccountModal — the inline "create account" dialog used by the voucher
// line editor's AccountCombobox "＋ New Account" action.
//
// WHY THIS FILE EXISTS (Track B B3/B4): this modal previously lived inline in
// VouchersPage as TWO byte-identical copies, both referencing `ACCT_TYPES` and
// `ACCT_SUBTYPES` — identifiers defined NOWHERE in the portal. Opening the modal
// threw `ReferenceError: ACCT_TYPES is not defined` and crashed the screen. It
// is extracted here so the constants have a home, the duplication is gone, and
// the dialog can be rendered by a test in isolation (it could not be before).
//
// The taxonomy mirrors the Chart of Accounts page (COAPage's ACCOUNT_TYPES /
// SUBTYPES_BY_TYPE) so a code created here classifies the same way it would there.

/** Account types, matching COAPage.ACCOUNT_TYPES. */
export const ACCT_TYPES = [
  'Asset',
  'Cost of Services',
  'Equity',
  'Expense',
  'Income',
  'Liability',
];

/** Sub-types per type, matching COAPage.SUBTYPES_BY_TYPE. */
export const ACCT_SUBTYPES = {
  Asset: [
    'Accounts Receivable',
    'Bank',
    'Cash Equivalents',
    'Fixed Asset',
    'Other Current Asset',
    'Tax Asset',
  ],
  'Cost of Services': ['Cost of Services'],
  Equity: ['Equity'],
  Expense: [
    'Finance Cost and Amortization',
    'General and Administrative Expenses',
    'Non Cash Expenses',
    'Other Expense',
    'Other General Expenses',
    'Personnel Cost',
    'Taxes and Licenses',
    'Utilities',
  ],
  Income: ['Income', 'Other Income'],
  Liability: ['Accounts Payable', 'Other Current Liability', 'Tax Liability'],
};

/**
 * Presentational modal. State is owned by the parent (VouchersPage), which passes
 * the working `modal` object, an `onChange` updater, the account list (for the
 * parent-account picker) and the save/cancel handlers.
 */
export default function NewAccountModal({
  modal,
  onChange,
  accounts = [],
  onCancel,
  onSave,
}) {
  if (!modal) return null;
  const subTypes = ACCT_SUBTYPES[modal.type] || [];

  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <strong>New Account</strong>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div
          className="modal-b"
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="field">
            <label>
              Account Code <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              value={modal.code}
              onChange={(e) =>
                onChange((m) => ({ ...m, code: e.target.value }))
              }
              placeholder="e.g. 5001001"
              autoFocus
            />
          </div>
          <div className="field">
            <label>
              Account Name <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              value={modal.name}
              onChange={(e) =>
                onChange((m) => ({ ...m, name: e.target.value }))
              }
              placeholder="e.g. Office Supplies"
            />
          </div>
          <div className="field">
            <label>Type</label>
            <select
              value={modal.type}
              onChange={(e) =>
                onChange((m) => ({
                  ...m,
                  type: e.target.value,
                  subType: (ACCT_SUBTYPES[e.target.value] || [''])[0],
                }))
              }
            >
              {ACCT_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Sub-Type</label>
            <select
              value={modal.subType}
              onChange={(e) =>
                onChange((m) => ({ ...m, subType: e.target.value }))
              }
            >
              {subTypes.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>
              Parent Account{' '}
              <span style={{ color: '#94a3b8', fontWeight: 400 }}>
                (optional)
              </span>
            </label>
            <select
              value={modal.parent}
              onChange={(e) =>
                onChange((m) => ({ ...m, parent: e.target.value }))
              }
            >
              <option value="">— None —</option>
              {accounts
                .filter((a) => !a.parent)
                .sort((a, b) => (a.code || '').localeCompare(b.code || ''))
                .map((a) => (
                  <option key={a.code || a.id} value={a.code || a.id}>
                    [{a.code}] {a.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onSave}
            disabled={modal.saving || !modal.code.trim() || !modal.name.trim()}
          >
            {modal.saving ? 'Saving…' : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  );
}
