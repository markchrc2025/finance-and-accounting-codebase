// Track B B4 — the "new account" modal must render without throwing.
//
// This modal lived inline in VouchersPage as two copies that referenced
// ACCT_TYPES / ACCT_SUBTYPES — identifiers defined nowhere in the portal — so it
// threw `ReferenceError: ACCT_TYPES is not defined` the moment it opened, a
// live crash in a shipped screen. It is now a component with the constants
// defined; this test renders it so that regression can never return silently.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import NewAccountModal, {
  ACCT_TYPES,
  ACCT_SUBTYPES,
} from './NewAccountModal.jsx';

const baseModal = {
  code: '',
  name: '',
  type: 'Expense',
  subType: 'General and Administrative Expenses',
  parent: '',
  saving: false,
};

function renderModal(overrides = {}) {
  return render(
    <NewAccountModal
      modal={{ ...baseModal, ...overrides }}
      onChange={() => {}}
      accounts={[{ code: '1000', name: 'Cash' }]}
      onCancel={() => {}}
      onSave={() => {}}
    />,
  );
}

describe('NewAccountModal (B4 crash fix)', () => {
  it('renders without throwing and shows the account-type options', () => {
    // If the constants were undefined (the original bug), this render throws.
    expect(() => renderModal()).not.toThrow();
    expect(screen.getByText('New Account')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create Account' }),
    ).toBeInTheDocument();

    // Every canonical account type is offered.
    for (const t of ACCT_TYPES) {
      expect(screen.getByRole('option', { name: t })).toBeInTheDocument();
    }
  });

  it('shows the sub-types for the selected type', () => {
    renderModal({ type: 'Asset' });
    // The Asset sub-types (e.g. Accounts Receivable, Bank) must render.
    for (const s of ACCT_SUBTYPES.Asset) {
      expect(screen.getByRole('option', { name: s })).toBeInTheDocument();
    }
  });

  it('returns null when there is no modal (closed state)', () => {
    const { container } = render(
      <NewAccountModal
        modal={null}
        onChange={() => {}}
        accounts={[]}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('invokes onSave when Create Account is clicked with a valid draft', async () => {
    const onSave = vi.fn();
    render(
      <NewAccountModal
        modal={{ ...baseModal, code: '5001001', name: 'Office Supplies' }}
        onChange={() => {}}
        accounts={[]}
        onCancel={() => {}}
        onSave={onSave}
      />,
    );
    await screen.getByRole('button', { name: 'Create Account' }).click();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
