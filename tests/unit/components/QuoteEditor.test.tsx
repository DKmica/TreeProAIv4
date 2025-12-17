import { render, screen, fireEvent, waitFor } from '../../setup/testUtils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import QuoteEditor from '../../../components/QuoteEditor';
import { quoteService, clientService } from '../../../services/apiService';
import { Quote, Client } from '../../../types';

vi.mock('../../../services/apiService', () => ({
  quoteService: {
    create: vi.fn(),
    update: vi.fn(),
  },
  clientService: {
    getAll: vi.fn(),
    getProperties: vi.fn(),
    create: vi.fn(),
  },
}));

describe('QuoteEditor', () => {
  const mockOnClose = vi.fn();
  const mockOnSave = vi.fn();

  const mockClients: Client[] = [
    {
      id: 'client-1',
      firstName: 'John',
      lastName: 'Doe',
      companyName: 'Doe Landscaping',
      primaryEmail: 'john@doe.com',
      primaryPhone: '555-1234',
      clientType: 'residential',
      status: 'active',
      clientCategory: 'active_customer',
      paymentTerms: 'Net 30',
      taxExempt: false,
      lifetimeValue: 0,
      billingCountry: 'USA',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clientService.getAll).mockResolvedValue(mockClients);
    vi.mocked(clientService.getProperties).mockResolvedValue([]);
  });

  it('should render empty form for new quote', async () => {
    render(
      <QuoteEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    expect(screen.getByText('Create Quote')).toBeInTheDocument();
    
    await waitFor(() => {
      expect(clientService.getAll).toHaveBeenCalled();
    });
  });

  it('should toggle between existing and new customer modes', async () => {
    render(
      <QuoteEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Select Existing Customer')).toBeInTheDocument();
      expect(screen.getByText('Create New Customer')).toBeInTheDocument();
    });

    const existingRadio = screen.getByLabelText('Select Existing Customer');
    const newRadio = screen.getByLabelText('Create New Customer');

    expect(existingRadio).toBeChecked();
    expect(newRadio).not.toBeChecked();

    fireEvent.click(newRadio);

    expect(newRadio).toBeChecked();
    expect(existingRadio).not.toBeChecked();

    await waitFor(() => {
      expect(screen.getByLabelText(/First name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Last name/i)).toBeInTheDocument();
    });
  });

  it('should load properties when client selected', async () => {
    const mockProperties = [
      {
        id: 'prop-1',
        clientId: 'client-1',
        propertyName: 'Main Property',
        addressLine1: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        zip: '12345',
        zipCode: '12345',
        country: 'USA',
        propertyType: 'residential',
        isPrimary: true,
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
      },
    ];

    vi.mocked(clientService.getProperties).mockResolvedValue(mockProperties);

    render(
      <QuoteEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Select Client/i)).toBeInTheDocument();
    });

    const clientSelect = screen.getByLabelText(/Select Client/i);
    fireEvent.change(clientSelect, { target: { value: 'client-1' } });

    await waitFor(() => {
      expect(clientService.getProperties).toHaveBeenCalledWith('client-1');
    });
  });

  it('should validate required fields', async () => {
    render(
      <QuoteEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Create Quote')).toBeInTheDocument();
    });

    const submitButton = screen.getByRole('button', { name: /Save Quote/i });
    
    expect(submitButton).toBeDisabled();
    
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(quoteService.create).not.toHaveBeenCalled();
    });

    expect(quoteService.create).not.toHaveBeenCalled();
  });

  it('should add and remove line items', async () => {
    render(
      <QuoteEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Create Quote')).toBeInTheDocument();
    });

    const addButton = screen.getByText(/Add Item/i);
    expect(addButton).toBeInTheDocument();

    fireEvent.click(addButton);

    await waitFor(() => {
      const lineItemInputs = screen.getAllByPlaceholderText(/Service description/i);
      expect(lineItemInputs.length).toBeGreaterThan(1);
    });
  });

  it('should submit quote data correctly', async () => {
    const mockCreatedQuote: Quote = {
      id: 'quote-new',
      quoteNumber: 'Q-202501-0001',
      clientId: 'client-1',
      customerName: 'Test Client',
      status: 'Draft',
      lineItems: [{ description: 'Tree Service', price: 300, selected: true }],
      paymentTerms: 'Net 30',
      taxRate: 0,
      discountPercentage: 0,
      totalAmount: 300,
      discountAmount: 0,
      taxAmount: 0,
      grandTotal: 300,
      version: 1,
      approvalStatus: 'pending',
      createdAt: '2025-01-15',
      updatedAt: '2025-01-15',
    };

    vi.mocked(quoteService.create).mockResolvedValue(mockCreatedQuote);

    render(
      <QuoteEditor
        isOpen={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Select Client/i)).toBeInTheDocument();
    });

    const clientSelect = screen.getByLabelText(/Select Client/i);
    fireEvent.change(clientSelect, { target: { value: 'client-1' } });

    const descriptionInputs = screen.getAllByPlaceholderText(/Service description/i);
    fireEvent.change(descriptionInputs[0], { target: { value: 'Tree Service' } });

    const priceInputs = screen.getAllByPlaceholderText('Price');
    fireEvent.change(priceInputs[0], { target: { value: '300' } });

    const submitButton = screen.getByRole('button', { name: /Save Quote/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(quoteService.create).toHaveBeenCalled();
      expect(mockOnSave).toHaveBeenCalledWith(mockCreatedQuote);
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});