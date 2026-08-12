// Track B B3 — collections posting screen tests.
//
// T1  Posting calls the REAL contract with the right payload, and a rejected
//     posting surfaces the SERVER'S actual reason.
// T2  THE EWT PROOF: a server EWT that is not 2% of anything the screen could
//     derive is displayed verbatim — proving EWT is captured, not computed. The
//     AR relief is the server's figure too, not a browser received+ewt.
// T3  No browser arithmetic on the sums or the balance flag — proven with a
//     server preview whose totals do not equal its line sums.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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
    serviceInvoicesApi: { list: vi.fn(() => Promise.resolve([])) },
    collectionsApi: { create: vi.fn(), update: vi.fn() },
    postCollection: vi.fn(),
    previewCollectionPost: vi.fn(),
  };
});

import CollectionsPostingPage from './CollectionsPostingPage.jsx';
import * as api from '../../../lib/api.js';

const CUSTOMER = { id: 'c1', name: 'Acme Corp', type: 'Customer' };
const INVOICE = {
  id: 'inv1',
  siNo: 'IS-0001',
  contactName: 'Acme Corp',
  status: 'Issued',
  amountCents: 100000,
  appliedCents: 0,
  balanceCents: 100000,
  netCents: 100000,
  vatTreatment: 'none',
};

function renderScreen() {
  return render(
    <MemoryRouter>
      <CollectionsPostingPage />
    </MemoryRouter>,
  );
}

async function selectCustomer(user) {
  await user.click(screen.getByText('Search customer…'));
  // The dropdown option renders the name in a <strong>; the invoice rows render
  // the same name in a plain div, so scope the click to the option element.
  await user.click(
    await screen.findByText('Acme Corp', { selector: 'strong' }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listContacts.mockResolvedValue([CUSTOMER]);
  api.listAccounts.mockResolvedValue([]);
  api.serviceInvoicesApi.list.mockResolvedValue([INVOICE]);
});

describe('T3 — renders and validates without a network', () => {
  it('renders the shell, lists outstanding invoices, and gates save until valid', async () => {
    const user = userEvent.setup();
    renderScreen();

    expect(
      screen.getByRole('heading', { name: 'Record a collection' }),
    ).toBeInTheDocument();
    // The issued, outstanding invoice appears in the allocation table.
    expect(await screen.findByText('IS-0001')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Amount received'), '1000');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();

    expect(api.collectionsApi.create).not.toHaveBeenCalled();
    expect(api.postCollection).not.toHaveBeenCalled();
  });
});

describe('T2 — EWT is captured, not computed; relief is the server figure', () => {
  it('displays the server EWT and AR relief verbatim, even when internally inconsistent', async () => {
    const user = userEvent.setup();
    // EWT 33333 is not 2% of the receipt (which would be 2000); relief 999999 is
    // not received+ewt (133333). A browser that derived either would show a
    // different number. Echoing the server shows ₱333.33 and ₱9,999.99.
    api.collectionsApi.create.mockResolvedValue({
      id: 'col1',
      status: 'Unposted',
      amountReceivedCents: 100000,
      ewtCents: 33333,
      arReliefCents: 999999,
    });

    renderScreen();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Amount received'), '1000');
    await user.type(screen.getByLabelText('EWT from 2307'), '333.33');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    const summary = await screen.findByTestId('receipt-summary');
    expect(
      within(within(summary).getByTestId('sum-ewt')).getByText('₱333.33'),
    ).toBeInTheDocument();
    expect(
      within(within(summary).getByTestId('sum-relief')).getByText('₱9,999.99'),
    ).toBeInTheDocument();
    // NOT the browser-derived received+ewt (₱1,333.33) nor a 2% figure (₱20.00).
    expect(screen.queryByText('₱1,333.33')).not.toBeInTheDocument();
    expect(screen.queryByText('₱20.00')).not.toBeInTheDocument();
  });
});

describe('T3 — no browser arithmetic on the preview sums or balance', () => {
  async function saveThenReview(user) {
    api.collectionsApi.create.mockResolvedValue({
      id: 'col1',
      status: 'Unposted',
      amountReceivedCents: 100000,
      ewtCents: 0,
      arReliefCents: 100000,
    });
    renderScreen();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Amount received'), '1000');
    await user.type(screen.getByLabelText('Apply to IS-0001'), '1000');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await user.click(
      screen.getByRole('button', { name: 'Review journal entry' }),
    );
  }

  it('takes the preview totals and balance flag from the server, not from summing lines', async () => {
    const user = userEvent.setup();
    api.previewCollectionPost.mockResolvedValue({
      lines: [
        {
          accountCode: '1010',
          accountName: 'Cash in Bank',
          debitCents: 100000,
          creditCents: 0,
        },
        {
          accountCode: '1001022',
          accountName: 'Trade Receivable',
          debitCents: 0,
          creditCents: 100000,
        },
      ],
      totalDebitCents: 700000, // deliberately not the line sum (100000)
      totalCreditCents: 700000,
      balanced: true,
    });

    await saveThenReview(user);

    const table = await screen.findByTestId('entry-preview');
    expect(within(table).getAllByText('₱7,000.00')).toHaveLength(2);
    expect(screen.getByTestId('balance-badge')).toHaveTextContent('Balanced');
  });

  it('renders an honest unavailable state with no fabricated amounts when the seam 404s', async () => {
    const user = userEvent.setup();
    api.previewCollectionPost.mockRejectedValue(
      new api.ApiError(404, { error: 'not_found' }),
    );

    await saveThenReview(user);

    const panel = await screen.findByTestId('preview-unavailable');
    expect(panel).toHaveTextContent('Server preview not available');
    expect(panel).toHaveTextContent('DR — Cash in Bank');
    expect(panel).toHaveTextContent('CR — Trade Receivable');
    expect(panel.textContent).not.toMatch(/₱\s*\d/);
  });
});

describe('T1 — posting calls the real contract and surfaces the server reason', () => {
  async function driveToPostable(user) {
    api.collectionsApi.create.mockResolvedValue({
      id: 'col1',
      status: 'Unposted',
      amountReceivedCents: 100000,
      ewtCents: 0,
      arReliefCents: 100000,
    });
    api.previewCollectionPost.mockRejectedValue(
      new api.ApiError(404, { error: 'not_found' }),
    );
    renderScreen();
    await selectCustomer(user);
    await user.type(screen.getByLabelText('Amount received'), '1000');
    await user.type(screen.getByLabelText('Apply to IS-0001'), '1000');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await user.click(
      screen.getByRole('button', { name: 'Review journal entry' }),
    );
    await screen.findByTestId('preview-unavailable');
  }

  it('calls postCollection with the collection id and the applications payload', async () => {
    const user = userEvent.setup();
    api.postCollection.mockResolvedValue({
      collection: { id: 'col1', status: 'Posted' },
      journalEntryNo: 'JE-2001',
      lines: [
        { accountCode: '1010', debitCents: 100000, creditCents: 0 },
        { accountCode: '1001022', debitCents: 0, creditCents: 100000 },
      ],
    });

    await driveToPostable(user);
    await user.click(screen.getByRole('button', { name: 'Post collection' }));

    await waitFor(() => expect(api.postCollection).toHaveBeenCalledTimes(1));
    const [id, body] = api.postCollection.mock.calls[0];
    expect(id).toBe('col1');
    expect(body).toEqual(
      expect.objectContaining({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        applications: [
          { invoiceId: 'inv1', appliedCents: 100000, ewtCents: 0 },
        ],
      }),
    );
    expect(await screen.findByText(/JE-2001/)).toBeInTheDocument();
  });

  it('surfaces the server’s over_application reason, not a generic failure', async () => {
    const user = userEvent.setup();
    api.postCollection.mockRejectedValue(
      new api.ApiError(409, {
        error: 'over_application',
        detail:
          'Applications must sum to the collection: applied 100000 vs received 90000, EWT 0 vs 0.',
      }),
    );

    await driveToPostable(user);
    await user.click(screen.getByRole('button', { name: 'Post collection' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Applications must sum to the collection');
  });
});
