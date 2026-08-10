// Track B B2 — invoice issuance screen tests.
//
// T1  Issuing from the screen calls the REAL contract with the right payload,
//     and a rejected issuance surfaces the SERVER'S actual reason.
// T2  No money arithmetic in the browser: every displayed amount comes verbatim
//     from a server response (proven with deliberately inconsistent server
//     numbers), and the unfilled preview seam renders its honest unavailable
//     state instead of computing anything.
// T3  The screen renders and validates without a network.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// ── Mock the API module. A real ApiError class is provided so the component's
//    `instanceof ApiError` checks and the tests share one identity. No network.
vi.mock('../../../lib/api.js', () => {
  class ApiError extends Error {
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
  return {
    ApiError,
    listContacts: vi.fn(() => Promise.resolve([])),
    listAccounts: vi.fn(() => Promise.resolve([])),
    serviceInvoicesApi: { create: vi.fn(), update: vi.fn() },
    issueInvoice: vi.fn(),
    previewInvoiceIssuance: vi.fn(),
  };
});

import InvoiceIssuancePage from './InvoiceIssuancePage.jsx';
import * as api from '../../../lib/api.js';

const CUSTOMER = { id: 'c1', name: 'Acme Corp', type: 'Customer' };

function renderScreen() {
  return render(
    <MemoryRouter>
      <InvoiceIssuancePage />
    </MemoryRouter>,
  );
}

async function selectCustomer(user) {
  // Open the ContactPicker (closed state shows the placeholder) and pick Acme.
  await user.click(screen.getByText('Search customer…'));
  await user.click(await screen.findByText('Acme Corp'));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listContacts.mockResolvedValue([CUSTOMER]);
  api.listAccounts.mockResolvedValue([]);
});

describe('T3 — renders and validates without a network', () => {
  it('renders the shell and gates commit on required fields, calling no write endpoint', async () => {
    const user = userEvent.setup();
    renderScreen();

    expect(
      screen.getByRole('heading', { name: 'Issue an invoice' }),
    ).toBeInTheDocument();

    // Empty form → cannot save (validation gate), and nothing was written.
    const save = screen.getByRole('button', { name: 'Save draft' });
    expect(save).toBeDisabled();

    // Fill the minimum and the gate opens — all client-side, no backend.
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Gross amount'), '1000');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();

    expect(api.serviceInvoicesApi.create).not.toHaveBeenCalled();
    expect(api.issueInvoice).not.toHaveBeenCalled();
    expect(api.previewInvoiceIssuance).not.toHaveBeenCalled();
  });
});

describe('T2 — no money arithmetic in the browser', () => {
  it('displays the server decomposition verbatim, even when it is internally inconsistent', async () => {
    const user = userEvent.setup();
    // net+vat = 78400, but the server says total 99900. A browser that computed
    // the total would show ₱784.00; echoing the server shows ₱999.00.
    api.serviceInvoicesApi.create.mockResolvedValue({
      id: 'inv1',
      status: 'Draft',
      vatTreatment: 'none',
      netCents: 70000,
      vatCents: 8400,
      amountCents: 99900,
    });

    renderScreen();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Gross amount'), '999');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    const decomp = await screen.findByTestId('decomposition');
    expect(
      within(within(decomp).getByTestId('decomp-net')).getByText('₱700.00'),
    ).toBeInTheDocument();
    expect(
      within(within(decomp).getByTestId('decomp-vat')).getByText('₱84.00'),
    ).toBeInTheDocument();
    // The total is the server's 99900, NOT the browser sum of net+vat (78400).
    expect(
      within(within(decomp).getByTestId('decomp-total')).getByText('₱999.00'),
    ).toBeInTheDocument();
    expect(screen.queryByText('₱784.00')).not.toBeInTheDocument();
  });

  it('takes the preview totals and balance flag from the server, not from summing lines', async () => {
    const user = userEvent.setup();
    api.serviceInvoicesApi.create.mockResolvedValue({
      id: 'inv1',
      status: 'Draft',
      vatTreatment: 'vatable',
      netCents: 100000,
      vatCents: 12000,
      amountCents: 112000,
    });
    // Server preview whose totals do NOT equal the line sums and yet is flagged
    // balanced — the panel must trust the server's numbers, not recompute.
    api.previewInvoiceIssuance.mockResolvedValue({
      lines: [
        {
          accountCode: '1001022',
          accountName: 'Trade Receivable',
          debitCents: 112000,
          creditCents: 0,
        },
        {
          accountCode: '4001',
          accountName: 'Service Revenue',
          debitCents: 0,
          creditCents: 100000,
        },
        {
          accountCode: '2003003',
          accountName: 'Output Tax',
          debitCents: 0,
          creditCents: 12000,
        },
      ],
      totalDebitCents: 500000, // deliberately wrong vs the lines
      totalCreditCents: 500000,
      balanced: true,
    });

    renderScreen();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Gross amount'), '1120');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await user.click(
      screen.getByRole('button', { name: 'Review journal entry' }),
    );

    const table = await screen.findByTestId('entry-preview');
    // Both totals are the server's 5000.00 (debit + credit). Summing the lines
    // in the browser would give 1120.00, which is NOT what is shown — the panel
    // trusts the server's totals. (₱1,120.00 does appear, but only as the
    // server-provided receivable LINE, not as a total.)
    expect(within(table).getAllByText('₱5,000.00')).toHaveLength(2);
    expect(screen.getByTestId('balance-badge')).toHaveTextContent('Balanced');
  });

  it('renders an honest unavailable state (no fabricated amounts) when the seam 404s', async () => {
    const user = userEvent.setup();
    api.serviceInvoicesApi.create.mockResolvedValue({
      id: 'inv1',
      status: 'Draft',
      vatTreatment: 'vatable',
      netCents: 100000,
      vatCents: 12000,
      amountCents: 112000,
    });
    api.previewInvoiceIssuance.mockRejectedValue(
      new api.ApiError(404, { error: 'not_found' }),
    );

    renderScreen();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Gross amount'), '1120');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await user.click(
      screen.getByRole('button', { name: 'Review journal entry' }),
    );

    const panel = await screen.findByTestId('preview-unavailable');
    expect(panel).toHaveTextContent('Server preview not available');
    // No fabricated peso figures inside the unavailable panel.
    expect(panel.textContent).not.toMatch(/₱\s*\d/);
  });
});

describe('T1 — issuance calls the real contract and surfaces the server reason', () => {
  async function driveToIssuable(user, { previewUnavailable = true } = {}) {
    api.serviceInvoicesApi.create.mockResolvedValue({
      id: 'inv1',
      status: 'Draft',
      vatTreatment: 'none',
      netCents: 100000,
      vatCents: 0,
      amountCents: 100000,
    });
    if (previewUnavailable) {
      api.previewInvoiceIssuance.mockRejectedValue(
        new api.ApiError(404, { error: 'not_found' }),
      );
    }
    renderScreen();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Gross amount'), '1000');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await user.click(
      screen.getByRole('button', { name: 'Review journal entry' }),
    );
    await screen.findByTestId('preview-unavailable');
  }

  it('calls issueInvoice with the invoice id and the account/date overrides', async () => {
    const user = userEvent.setup();
    api.issueInvoice.mockResolvedValue({
      invoice: { id: 'inv1', status: 'Issued' },
      journalEntryNo: 'JE-1001',
      lines: [
        {
          accountCode: '1001022',
          debitCents: 100000,
          creditCents: 0,
          description: 'Trade Receivable',
        },
        {
          accountCode: '4001',
          debitCents: 0,
          creditCents: 100000,
          description: 'Revenue',
        },
      ],
    });

    await driveToIssuable(user);
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));

    await waitFor(() => expect(api.issueInvoice).toHaveBeenCalledTimes(1));
    const [id, overrides] = api.issueInvoice.mock.calls[0];
    expect(id).toBe('inv1');
    expect(overrides).toEqual(
      expect.objectContaining({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        arAccountCode: null,
        incomeAccountCode: null,
        outputVatAccountCode: null,
      }),
    );
    expect(await screen.findByText(/JE-1001/)).toBeInTheDocument();
  });

  it('surfaces the server’s actual rejection reason (409 already_issued), not a generic failure', async () => {
    const user = userEvent.setup();
    api.issueInvoice.mockRejectedValue(
      new api.ApiError(409, {
        error: 'already_issued',
        detail: 'This invoice is already issued to the ledger.',
      }),
    );

    await driveToIssuable(user);
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This invoice is already issued to the ledger.',
    );
  });

  it('surfaces a 400 accounts_unset reason a bookkeeper can act on', async () => {
    const user = userEvent.setup();
    api.issueInvoice.mockRejectedValue(
      new api.ApiError(400, {
        error: 'accounts_unset',
        detail:
          'Set the receivable and income accounts before issuing — either on the invoice, or as the customer’s AR account on their contact record.',
      }),
    );

    await driveToIssuable(user);
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Set the receivable and income accounts before issuing',
    );
  });
});
