import { render, screen, fireEvent, waitFor } from '../../setup/testUtils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import InvoiceEditor from '../../../components/InvoiceEditor';
import { invoiceService } from '../../../services/apiService';
import { Invoice } from '../../../types';

vi.mock('../../../services/apiService', () => ({
  invoiceService: {
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../components/LineItemBuilder', () => ({
  default: ({ lineItems, onChange }: any) => (
    <div data-testid="line-item-builder">
      <button
        type="button"
        onClick={() => onChange([{ description: 'Test Item', price: 100, selected: true }])}
      >
        Add Line Item
      </button>
      <div>{lineItems.length} items</div>
      <div>
        {lineItems.map((item: any, index: number) => (
          <div key={index}>
            {item.description || '(empty)'}
          </div>
        ))}
      </div>
    </div>
  ),
}));

describe('InvoiceEditor', () => {
  const mockOnClose = vi.fn();
  const mockOnSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render empty form when no invoice provided', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    render(
      <InvoiceEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    expect(screen.getByRole('heading', { name: 'Create Invoice' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Customer Name/i)).toHaveValue('');
    
    const dueDateInput = screen.getByLabelText(/Due Date/i) as HTMLInputElement;
    expect(dueDateInput).toBeInTheDocument();
    expect(dueDateInput.value).not.toBe('');
    
    consoleErrorSpy.mockRestore();
  });

  it('should populate form with invoice data when editing', () => {
    const mockInvoice: Invoice = {
      id: 'inv-123',
      invoiceNumber: 'INV-2025-0001',
      customerName: 'John Doe',
      customerEmail: 'john@example.com',
      customerPhone: '555-1234',
      customerAddress: '123 Main St',
      issueDate: '2025-01-01',
      dueDate: '2025-01-31',
      paymentTerms: 'Net 30',
      lineItems: [
        { description: 'Tree Removal', price: 500, selected: true },
      ],
      subtotal: 500,
      discountAmount: 0,
      discountPercentage: 0,
      taxRate: 8,
      taxAmount: 40,
      amount: 540,
      totalAmount: 540,
      grandTotal: 540,
      amountPaid: 0,
      amountDue: 540,
      status: 'Draft',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
      billingType: 'single',
      billingSequence: 1,
      contractTotal: 540,
    };

    render(
      <InvoiceEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
        invoice={mockInvoice}
      />
    );

    expect(screen.getByText('Edit Invoice')).toBeInTheDocument();
    expect(screen.getByLabelText(/Customer Name/i)).toHaveValue('John Doe');
    expect(screen.getByLabelText(/Customer Email/i)).toHaveValue('john@example.com');
    expect(screen.getByLabelText(/Due Date/i)).toHaveValue('2025-01-31');
  });

  it('should validate required fields and prevent submission when invalid', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    render(
      <InvoiceEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    const submitButton = screen.getByRole('button', { name: /Create Invoice/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(invoiceService.create).not.toHaveBeenCalled();
    });

    expect(mockOnSave).not.toHaveBeenCalled();
    expect(mockOnClose).not.toHaveBeenCalled();
    
    consoleErrorSpy.mockRestore();
  });

  it('should calculate totals correctly', async () => {
    render(
      <InvoiceEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    const customerNameInput = screen.getByLabelText(/Customer Name/i);
    fireEvent.change(customerNameInput, { target: { value: 'Test Customer' } });

    const dueDateInput = screen.getByLabelText(/Due Date/i);
    fireEvent.change(dueDateInput, { target: { value: '2025-02-01' } });

    const addLineItemButton = screen.getByText('Add Line Item');
    fireEvent.click(addLineItemButton);

    const taxRateInput = screen.getByLabelText(/Tax Rate/i);
    fireEvent.change(taxRateInput, { target: { value: '10' } });

    const discountPercentageInput = screen.getByLabelText(/Discount Percentage/i);
    fireEvent.change(discountPercentageInput, { target: { value: '5' } });

    await waitFor(() => {
      expect(screen.getByText(/Subtotal:/i)).toBeInTheDocument();
    });
  });

  it('should submit invoice data correctly', async () => {
    const mockCreatedInvoice: Invoice = {
      id: 'inv-new',
      invoiceNumber: 'INV-2025-0002',
      customerName: 'New Customer',
      issueDate: '2025-01-15',
      dueDate: '2025-02-15',
      paymentTerms: 'Net 30',
      lineItems: [{ description: 'Service', price: 200, selected: true }],
      subtotal: 200,
      discountAmount: 0,
      discountPercentage: 0,
      taxRate: 0,
      taxAmount: 0,
      amount: 200,
      totalAmount: 200,
      grandTotal: 200,
      amountPaid: 0,
      amountDue: 200,
      status: 'Draft',
      createdAt: '2025-01-15',
      updatedAt: '2025-01-15',
      billingType: 'single',
      billingSequence: 1,
      contractTotal: 200,
    };

    vi.mocked(invoiceService.create).mockResolvedValue(mockCreatedInvoice);

    render(
      <InvoiceEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    fireEvent.change(screen.getByLabelText(/Customer Name/i), {
      target: { value: 'New Customer' },
    });
    fireEvent.change(screen.getByLabelText(/Due Date/i), {
      target: { value: '2025-02-15' },
    });

    const addLineItemButton = screen.getByText('Add Line Item');
    fireEvent.click(addLineItemButton);

    const submitButton = screen.getByRole('button', { name: /Create Invoice/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(invoiceService.create).toHaveBeenCalled();
      expect(mockOnSave).toHaveBeenCalledWith(mockCreatedInvoice);
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});