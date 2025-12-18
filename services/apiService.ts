import {
  AiAccuracyStats,
  AiJobDurationPrediction,
  AiQuoteRecommendation,
  AiRiskAssessment,
  AiSchedulingSuggestion,
  AiWorkflowRecommendation,
  Client,
  Contact,
  Crew,
  CrewAssignment,
  CrewAvailabilitySummary,
  CrewMember,
  Customer,
  CustomerActivityEvent,
  CustomerSegment,
  DispatchResult,
  EmailCampaignSend,
  Employee,
  Equipment,
  EstimateFeedback,
  EstimateFeedbackStats,
  FormTemplate,
  IntegrationConnection,
  IntegrationProvider,
  IntegrationTestResult,
  Invoice,
  Job,
  JobForm,
  JobTemplate,
  Lead,
  MaintenanceLog,
  NurtureSequence,
  PayPeriod,
  PayrollRecord,
  Property,
  Quote,
  QuotePricingOption,
  QuoteProposalData,
  QuoteVersion,
  RecurringJobInstance,
  RecurringJobSeries,
  RouteOptimizationResult,
  TimeEntry,
  WebLeadFormConfig,
  WeatherImpact,
  CompanyProfile
} from '../types';
import { PaginationParams, PaginatedResponse } from '../types/pagination';
import { getAccessToken } from './supabaseClient';

type ApiFetchOptions = RequestInit & {
  useAuth?: boolean;
};

const DEV_FALLBACK_TOKEN = import.meta.env.VITE_DEV_AUTH_TOKEN as string | undefined;

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} - ${errorText}`);
  }
  
  // Handle empty responses (e.g., DELETE operations)
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  
  return response.json() as Promise<T>;
}

// Generic fetch function with timeout
async function apiFetch<T>(endpoint: string, options: ApiFetchOptions = {}): Promise<T> {
  const url = `/api/${endpoint}`;
  const timeout = 10000;
  const { useAuth = true, ...rest } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(rest.headers as Record<string, string> | undefined),
  };

  if (useAuth) {
    try {
      const accessToken = await getAccessToken();
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      } else if (import.meta.env.DEV && DEV_FALLBACK_TOKEN) {
        headers.Authorization = `Bearer ${DEV_FALLBACK_TOKEN}`;
      }
    } catch (err) {
      console.warn('Unable to read Supabase session for API request:', err);
    }
  }

  try {
    const response = await fetch(url, {
      ...rest,
      headers,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    return handleResponse<T>(response);
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - backend server may be unavailable');
    }
    
    if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError')) {
      throw new Error('Cannot connect to backend server - please check if it is running');
    }
    
    throw error;
  }
}

export function buildPaginatedUrl(endpoint: string, params?: PaginationParams): string {
  if (!params) return endpoint;
  
  const searchParams = new URLSearchParams();
  
  if (params.page !== undefined) {
    searchParams.set('page', params.page.toString());
  }
  if (params.pageSize !== undefined) {
    searchParams.set('pageSize', params.pageSize.toString());
  }
  if (params.search !== undefined && params.search.trim() !== '') {
    searchParams.set('search', params.search.trim());
  }
  
  const queryString = searchParams.toString();
  return queryString ? `${endpoint}?${queryString}` : endpoint;
}

export async function fetchPaginated<T>(
  endpoint: string,
  params?: PaginationParams
): Promise<PaginatedResponse<T>> {
  const url = buildPaginatedUrl(endpoint, params);
  const response = await apiFetch<{ success: boolean; data: T[]; pagination: PaginatedResponse<T>['pagination'] }>(url);
  return {
    data: response.data ?? [],
    pagination: response.pagination,
  };
}

// Generic CRUD operations
const createApiService = <T extends { id: string }>(resource: string) => ({
  getAll: (): Promise<T[]> => apiFetch(resource),
  getById: (id: string): Promise<T> => apiFetch(`${resource}/${id}`),
  create: (data: Partial<Omit<T, 'id'>>): Promise<T> => apiFetch(resource, { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<T>): Promise<T> => apiFetch(`${resource}/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string): Promise<void> => apiFetch<void>(`${resource}/${id}`, { method: 'DELETE' }),
});

export const customerService = createApiService<Customer>('customers');
export const clientService = {
  getAll: async (params?: { clientCategory?: string }): Promise<Client[]> => {
    const query = params ? new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString() : '';
    const endpoint = query ? `clients?${query}` : 'clients';
    const response = await apiFetch<{ success: boolean; data: Client[]; pagination: any }>(endpoint);
    return response.data ?? [];
  },
  getById: async (id: string): Promise<Client> => {
    const response = await apiFetch<{ success: boolean; data: Client }>(`clients/${id}`);
    return response.data;
  },
  create: (data: Partial<Omit<Client, 'id'>>): Promise<Client> => apiFetch('clients', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Client>): Promise<Client> => apiFetch(`clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string): Promise<void> => apiFetch<void>(`clients/${id}`, { method: 'DELETE' }),
  getProperties: async (clientId: string): Promise<Property[]> => {
    const response = await apiFetch<{ success: boolean; data: Property[] }>(`clients/${clientId}/properties`);
    return response.data;
  },
  getContacts: async (clientId: string): Promise<Contact[]> => {
    const response = await apiFetch<{ success: boolean; data: Contact[] }>(`clients/${clientId}/contacts`);
    return response.data;
  },
  getActivity: async (clientId: string): Promise<CustomerActivityEvent[]> => {
    const response = await apiFetch<{ success: boolean; data: CustomerActivityEvent[] }>(`clients/${clientId}/activity`);
    return response.data ?? [];
  },
};
export const propertyService = {
  ...createApiService<Property>('properties'),
  createForClient: (clientId: string, data: Partial<Omit<Property, 'id'>>): Promise<Property> => 
    apiFetch(`clients/${clientId}/properties`, { method: 'POST', body: JSON.stringify(data) }),
};
export const leadService = createApiService<Lead>('leads');
export const segmentService = {
  getAll: async (): Promise<CustomerSegment[]> => {
    const response = await apiFetch<{ success: boolean; data: CustomerSegment[] }>('segments');
    return response.data ?? [];
  },
  preview: async (segmentId: string): Promise<{ audienceCount: number; sampleTags?: string[] }> => {
    const response = await apiFetch<{ success: boolean; data: { audienceCount: number; sampleTags?: string[] } }>(`segments/${segmentId}/preview`);
    return response.data ?? { audienceCount: 0 };
  },
};

export const marketingService = {
  sendCampaign: async (payload: { segmentId: string; subject: string; body: string; scheduleAt?: string }): Promise<EmailCampaignSend> => {
    const response = await apiFetch<{ success: boolean; data: EmailCampaignSend }>('marketing/campaigns/send', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return response.data;
  },
  getNurtureSequences: async (): Promise<NurtureSequence[]> => {
    const response = await apiFetch<{ success: boolean; data: NurtureSequence[] }>('marketing/nurture-sequences');
    return response.data ?? [];
  },
  updateNurtureStatus: async (sequenceId: string, status: NurtureSequence['status']): Promise<NurtureSequence> => {
    const response = await apiFetch<{ success: boolean; data: NurtureSequence }>(`marketing/nurture-sequences/${sequenceId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    return response.data;
  },
  getWebLeadForms: async (): Promise<WebLeadFormConfig[]> => {
    const response = await apiFetch<{ success: boolean; data: WebLeadFormConfig[] }>('marketing/web-lead-forms');
    return response.data ?? [];
  },
  previewEmbed: async (formId: string): Promise<{ embedToken: string; scriptUrl: string }> => {
    const response = await apiFetch<{ success: boolean; data: { embedToken: string; scriptUrl: string } }>(`marketing/web-lead-forms/${formId}/embed`);
    return response.data;
  }
};

export const integrationService = {
  getConnections: async (): Promise<IntegrationConnection[]> => {
    const response = await apiFetch<{ success: boolean; data: IntegrationConnection[] }>('integrations');
    return response.data ?? [];
  },
  connect: async (
    provider: IntegrationProvider,
    payload?: { environment?: 'sandbox' | 'production'; scopes?: string[] }
  ): Promise<IntegrationConnection> => {
    const response = await apiFetch<{ success: boolean; data: IntegrationConnection }>(`integrations/${provider}/connect`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {})
    });
    return response.data;
  },
  disconnect: async (provider: IntegrationProvider): Promise<void> => {
    await apiFetch<void>(`integrations/${provider}`, { method: 'DELETE' });
  },
  refreshStatus: async (provider: IntegrationProvider): Promise<IntegrationConnection> => {
    const response = await apiFetch<{ success: boolean; data: IntegrationConnection }>(`integrations/${provider}`);
    return response.data;
  },
  triggerSync: async (provider: IntegrationProvider): Promise<IntegrationConnection> => {
    const response = await apiFetch<{ success: boolean; data: IntegrationConnection }>(`integrations/${provider}/sync`, { method: 'POST' });
    return response.data;
  },
  sendTest: async (provider: IntegrationProvider): Promise<IntegrationTestResult> => {
    const response = await apiFetch<{ success: boolean; data: IntegrationTestResult }>(`integrations/${provider}/test`, {
      method: 'POST'
    });
    return response.data;
  }
};
export const quoteService = {
  getAll: async (): Promise<Quote[]> => {
    const response = await apiFetch<{ success: boolean; data: Quote[]; pagination: any }>('quotes');
    return response.data ?? [];
  },
  getById: async (id: string): Promise<Quote> => {
    const response = await apiFetch<{ success: boolean; data: Quote }>(`quotes/${id}`);
    return response.data;
  },
  convertToJob: async (id: string): Promise<Job> => {
    const response = await apiFetch<{ success: boolean; data: Job; message?: string }>(`quotes/${id}/convert-to-job`, {
      method: 'POST',
    });
    return response.data;
  },
  create: (data: Partial<Omit<Quote, 'id'>>): Promise<Quote> => apiFetch('quotes', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Quote>): Promise<Quote> => apiFetch(`quotes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string): Promise<void> => apiFetch<void>(`quotes/${id}`, { method: 'DELETE' }),
  convertToInvoice: async (id: string): Promise<{ invoice: Invoice; quote: Quote }> => {
    const response = await apiFetch<{ success: boolean; data: { invoice: Invoice; quote: Quote } }>(
      `quotes/${id}/convert-to-invoice`,
      { method: 'POST' }
    );
    return response.data;
  },
  getProposal: async (quoteId: string): Promise<QuoteProposalData> => {
    const response = await apiFetch<{ success: boolean; data: QuoteProposalData }>(`quotes/${quoteId}/proposal`);
    return response.data;
  },
  getPricingOptions: async (quoteId: string): Promise<QuotePricingOption[]> => {
    const response = await apiFetch<{ success: boolean; data: QuotePricingOption[] }>(`quotes/${quoteId}/pricing-options`);
    return response.data ?? [];
  },
  recommendPricingOption: async (optionId: string): Promise<QuotePricingOption> => {
    const response = await apiFetch<{ success: boolean; data: QuotePricingOption }>(
      `quotes/pricing-options/${optionId}/recommend`,
      { method: 'POST' }
    );
    return response.data;
  },
  selectPricingOption: async (quoteId: string, optionId: string): Promise<{ selected: QuotePricingOption; options: QuotePricingOption[] }> => {
    const response = await apiFetch<{ success: boolean; data: { selected: QuotePricingOption; options: QuotePricingOption[] } }>(
      `quotes/${quoteId}/select-option`,
      { method: 'POST', body: JSON.stringify({ optionId }) }
    );
    return response.data;
  },
  getVersionHistory: async (quoteId: string): Promise<QuoteVersion[]> => {
    const response = await apiFetch<{ success: boolean; data: QuoteVersion[] }>(`quotes/${quoteId}/versions`);
    return response.data ?? [];
  },
  createVersion: async (quoteId: string, changesSummary?: string): Promise<QuoteVersion> => {
    const response = await apiFetch<{ success: boolean; data: QuoteVersion }>(`quotes/${quoteId}/versions`, {
      method: 'POST',
      body: JSON.stringify({ changesSummary })
    });
    return response.data;
  },
  recordSignature: async (
    quoteId: string,
    payload: { signerName: string; signerEmail?: string; signerPhone?: string; signatureData: string; signedAt?: string }
  ) => {
    const response = await apiFetch<{ success: boolean; data: any }>(`quotes/${quoteId}/signature`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return response.data;
  },
  requestSignature: async (quoteId: string, payload: { signerName: string; signerEmail?: string; signerPhone?: string }): Promise<any> => {
    const response = await apiFetch<{ success: boolean; data: any }>(`quotes/${quoteId}/request-signature`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return response.data;
  },
  recordAccuracy: async (quoteId: string, actualPrice: number, feedback?: { notes?: string; corrections?: string[]; ai_suggestions_followed?: boolean }) => {
    const response = await apiFetch<{ success: boolean; data: any }>(`quotes/${quoteId}/accuracy-feedback`, {
      method: 'POST',
      body: JSON.stringify({ actualPrice, feedback })
    });
    return response.data;
  },
  getAiAccuracyStats: async (period: 'week' | 'month' | 'quarter' | 'year' = 'month'): Promise<AiAccuracyStats> => {
    const response = await apiFetch<{ success: boolean; data: AiAccuracyStats }>(`analytics/ai-accuracy?period=${period}`);
    return response.data;
  },
  getConversionAnalytics: async (): Promise<any> => {
    const response = await apiFetch<{ success: boolean; data: any }>('analytics/conversions');
    return response.data;
  }
};
export const jobService = createApiService<Job>('jobs');
export const invoiceService = {
  getAll: async (): Promise<Invoice[]> => {
    const response = await apiFetch<{ success: boolean; data: Invoice[] }>('invoices');
    return response.data ?? [];
  },
  getById: (id: string): Promise<Invoice> => apiFetch(`invoices/${id}`),
  create: (data: Partial<Omit<Invoice, 'id'>>): Promise<Invoice> => apiFetch('invoices', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Invoice>): Promise<Invoice> => apiFetch(`invoices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string): Promise<void> => apiFetch<void>(`invoices/${id}`, { method: 'DELETE' }),
  recordPayment: (invoiceId: string, paymentData: { amount: number; paymentDate: string; paymentMethod: string; referenceNumber?: string; notes?: string }): Promise<{ success: boolean; payment: any; invoice: Invoice }> =>
    apiFetch(`invoices/${invoiceId}/payments`, { method: 'POST', body: JSON.stringify(paymentData) }),
  generatePaymentLink: (invoiceId: string): Promise<{ success: boolean; paymentLink: string }> =>
    apiFetch(`invoices/${invoiceId}/payment-link`, { method: 'POST' }),
};
export const employeeService = createApiService<Employee>('employees');
export const equipmentService = createApiService<Equipment>('equipment');
export const payPeriodService = {
  ...createApiService<PayPeriod>('pay_periods'),
  process: async (id: string): Promise<{ payPeriod: PayPeriod; payrollRecords: PayrollRecord[] }> => {
    return apiFetch(`pay_periods/${id}/process`, { method: 'POST' });
  }
};
export const timeEntryService = createApiService<TimeEntry>('time_entries');
export const payrollRecordService = createApiService<PayrollRecord>('payroll_records');

// Special case for maintenance logs
export const addMaintenanceLog = async (equipmentId: string, log: Omit<MaintenanceLog, 'id'>): Promise<Equipment> => {
    // Fetch current equipment
    const equipment = await equipmentService.getById(equipmentId);
    
    // Add new log with generated ID
    const newLog: MaintenanceLog = {
        id: `maint-${Date.now()}`,
        ...log
    };
    
    const updatedHistory = [...(equipment.maintenanceHistory || []), newLog];
    
    // Update the last service date if the new log date is the most recent
    const mostRecentDate = updatedHistory.reduce(
        (latest, current) => new Date(current.date) > new Date(latest) ? current.date : latest, 
        equipment.lastServiceDate
    );
    
    // Update equipment with new maintenance log
    return equipmentService.update(equipmentId, {
        maintenanceHistory: updatedHistory,
        lastServiceDate: mostRecentDate
    });
};

// Company Profile Service (singleton pattern)
export const companyProfileService = {
  get: (): Promise<CompanyProfile> => apiFetch('company-profile'),
  update: (data: Partial<CompanyProfile>): Promise<CompanyProfile> => apiFetch('company-profile', { method: 'PUT', body: JSON.stringify(data) }),
};

// Estimate Feedback Service
export const estimateFeedbackService = {
  submitEstimateFeedback: async (feedback: Omit<EstimateFeedback, 'id' | 'createdAt'>): Promise<EstimateFeedback> => {
    return apiFetch('estimate_feedback', { method: 'POST', body: JSON.stringify(feedback) });
  },
  getEstimateFeedback: (): Promise<EstimateFeedback[]> => apiFetch('estimate_feedback'),
  getEstimateFeedbackStats: (): Promise<EstimateFeedbackStats> => apiFetch('estimate_feedback/stats'),
};

export const jobStateService = {
  getAllowedTransitions: (jobId: string): Promise<{currentState: string; transitions: any[]}> => 
    apiFetch(`jobs/${jobId}/allowed-transitions`),
  transitionState: (jobId: string, data: {toState: string; reason?: string; notes?: any}): Promise<Job> =>
    apiFetch(`jobs/${jobId}/state-transitions`, { method: 'POST', body: JSON.stringify(data) }),
  getStateHistory: (jobId: string): Promise<{currentState: string; history: any[]}> =>
    apiFetch(`jobs/${jobId}/state-history`)
};

export const getApiErrorMessage = (error: any, fallback = 'An unknown error occurred') => {
  if (!error) return fallback;

  const message = error.message || fallback;

  if (typeof message === 'string') {
    const separatorIndex = message.indexOf(' - {');
    if (separatorIndex !== -1) {
      const possibleJson = message.slice(separatorIndex + 3);
      try {
        const parsed = JSON.parse(possibleJson);
        if (parsed?.error) return parsed.error;
      } catch {
        // Ignore JSON parse errors and fall back to the original message
      }
    }
  }

  return typeof message === 'string' ? message : fallback;
};

export const jobTemplateService = {
  getAll: async (filters?: {category?: string; search?: string; limit?: number}): Promise<JobTemplate[]> => {
    const params: Record<string, string> = {};
    if (filters?.category) params.category = filters.category;
    if (filters?.search) params.search = filters.search;
    if (filters?.limit) params.limit = filters.limit.toString();
    const queryString = new URLSearchParams(params).toString();
    const response = await apiFetch<{success: boolean; data: JobTemplate[]}>(`job-templates${queryString ? `?${queryString}` : ''}`);
    return response.data ?? [];
  },
  getByCategory: async (): Promise<{category: string; templates: JobTemplate[]}[]> => {
    const response = await apiFetch<{success: boolean; data: {category: string; templates: JobTemplate[]}[]}>('job-templates/by-category');
    return response.data ?? [];
  },
  getUsageStats: async (): Promise<JobTemplate[]> => {
    const response = await apiFetch<{success: boolean; data: JobTemplate[]}>('job-templates/usage-stats');
    return response.data ?? [];
  },
  getById: async (id: string): Promise<JobTemplate> => {
    const response = await apiFetch<{success: boolean; data: JobTemplate}>(`job-templates/${id}`);
    return response.data;
  },
  create: async (data: Partial<JobTemplate>): Promise<JobTemplate> => {
    const response = await apiFetch<{success: boolean; data: JobTemplate}>('job-templates', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    return response.data;
  },
  createFromJob: async (jobId: string, data: Partial<JobTemplate>): Promise<JobTemplate> => {
    const response = await apiFetch<{success: boolean; data: JobTemplate}>(`job-templates/from-job/${jobId}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    return response.data;
  },
  update: async (id: string, data: Partial<JobTemplate>): Promise<JobTemplate> => {
    const response = await apiFetch<{success: boolean; data: JobTemplate}>(`job-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    return response.data;
  },
  remove: async (id: string): Promise<void> => {
    await apiFetch<{success: boolean}>(`job-templates/${id}`, {
      method: 'DELETE'
    });
  },
  useTemplate: async (id: string, overrideData?: Partial<Job>): Promise<Job> => {
    const response = await apiFetch<{success: boolean; data: Job}>(`job-templates/${id}/use`, {
      method: 'POST',
      body: JSON.stringify(overrideData || {})
    });
    return response.data;
  }
};

export const crewService = {
  getAll: async (): Promise<Crew[]> => {
    const response = await apiFetch<{ success: boolean; data: Crew[] }>('crews');
    return response.data ?? [];
  },
  getById: (id: string): Promise<Crew> => apiFetch(`crews/${id}`),
  create: (data: Partial<Omit<Crew, 'id'>>): Promise<Crew> => apiFetch('crews', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Crew>): Promise<Crew> => apiFetch(`crews/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string): Promise<void> => apiFetch<void>(`crews/${id}`, { method: 'DELETE' }),
  getMembers: (crewId: string): Promise<CrewMember[]> => apiFetch(`crews/${crewId}/members`),
  addMember: (crewId: string, data: { employeeId: string; role: string }): Promise<CrewMember> => 
    apiFetch(`crews/${crewId}/members`, { method: 'POST', body: JSON.stringify(data) }),
  updateMemberRole: (crewId: string, memberId: string, role: string): Promise<CrewMember> =>
    apiFetch(`crews/${crewId}/members/${memberId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  removeMember: (crewId: string, memberId: string): Promise<void> =>
    apiFetch<void>(`crews/${crewId}/members/${memberId}`, { method: 'DELETE' }),
  getAvailable: (date: string): Promise<Crew[]> => apiFetch(`crews/available?date=${encodeURIComponent(date)}`),
  getUnassignedEmployees: (): Promise<Employee[]> => apiFetch('employees/unassigned'),
};

export const crewAssignmentService = {
  getSchedule: async (params?: { startDate?: string; endDate?: string; crewId?: string }): Promise<CrewAssignment[]> => {
    const queryParams = new URLSearchParams();
    if (params?.startDate) queryParams.append('start_date', params.startDate);
    if (params?.endDate) queryParams.append('end_date', params.endDate);
    if (params?.crewId) queryParams.append('crew_id', params.crewId);
    const queryString = queryParams.toString();
    const response = await apiFetch<{ success: boolean; data: CrewAssignment[] }>(`crew-assignments/schedule${queryString ? `?${queryString}` : ''}`);
    return response.data || [];
  },
  create: async (data: { jobId: string; crewId: string; assignedDate: string; notes?: string }): Promise<CrewAssignment> => {
    const response = await apiFetch<{ success: boolean; data: CrewAssignment[] }>('crew-assignments/bulk-assign', { 
      method: 'POST', 
      body: JSON.stringify({ 
        job_id: data.jobId, 
        crew_id: data.crewId, 
        dates: [data.assignedDate], 
        notes: data.notes 
      }) 
    });
    return response.data[0];
  },
  bulkAssign: (data: { jobId: string; crewId: string; dates: string[]; notes?: string }): Promise<CrewAssignment[]> =>
    apiFetch('crew-assignments/bulk-assign', { 
      method: 'POST', 
      body: JSON.stringify({ job_id: data.jobId, crew_id: data.crewId, dates: data.dates, notes: data.notes }) 
    }),
  checkConflictForCrewAndDate: (crewId: string, assignedDate: string, jobId?: string): Promise<{ hasConflict: boolean; conflicts: any[] }> =>
    apiFetch('crew-assignments/check-conflicts', { 
      method: 'POST', 
      body: JSON.stringify({ crew_id: crewId, assigned_date: assignedDate, job_id: jobId }) 
    }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`crew-assignments/${id}`, { method: 'DELETE' }),
};

export const formService = {
  getTemplates: async (filters?: { category?: string; search?: string }): Promise<FormTemplate[]> => {
    const params: Record<string, string> = {};
    if (filters?.category) params.category = filters.category;
    if (filters?.search) params.search = filters.search;
    const queryString = new URLSearchParams(params).toString();
    const response = await apiFetch<{ success: boolean; data: FormTemplate[] }>(`form-templates${queryString ? `?${queryString}` : ''}`);
    return response.data ?? [];
  },
  getCategories: async (): Promise<string[]> => {
    const response = await apiFetch<{ success: boolean; data: string[] }>('form-templates/categories');
    return response.data ?? [];
  },
  getTemplate: (id: string): Promise<FormTemplate> => apiFetch(`form-templates/${id}`),
  createTemplate: (data: Partial<Omit<FormTemplate, 'id'>>): Promise<FormTemplate> => 
    apiFetch('form-templates', { method: 'POST', body: JSON.stringify(data) }),
  updateTemplate: (id: string, data: Partial<FormTemplate>): Promise<FormTemplate> => 
    apiFetch(`form-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTemplate: (id: string): Promise<void> => 
    apiFetch<void>(`form-templates/${id}`, { method: 'DELETE' }),
  
  attachFormToJob: (jobId: string, templateId: string): Promise<JobForm> => 
    apiFetch(`jobs/${jobId}/forms`, { method: 'POST', body: JSON.stringify({ templateId }) }),
  getJobForms: (jobId: string): Promise<JobForm[]> => apiFetch(`jobs/${jobId}/forms`),
  getJobForm: (id: string): Promise<JobForm> => apiFetch(`job-forms/${id}`),
  submitFormData: (id: string, formData: Record<string, any>): Promise<JobForm> => 
    apiFetch(`job-forms/${id}/submit`, { method: 'PUT', body: JSON.stringify({ formData }) }),
  completeForm: (id: string): Promise<JobForm> =>
    apiFetch(`job-forms/${id}/complete`, { method: 'PUT' }),
  deleteJobForm: (id: string): Promise<void> =>
    apiFetch<void>(`job-forms/${id}`, { method: 'DELETE' }),
};

export const operationsService = {
  optimizeRoute: async (payload: { date: string; crewId?: string; startLocation?: string; includeInProgress?: boolean }): Promise<RouteOptimizationResult> => {
    const response = await apiFetch<{ success: boolean; data: RouteOptimizationResult }>('operations/route-optimize', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return response.data;
  },
  getRoutePlan: async (params: { date: string; crewId: string }): Promise<RouteOptimizationResult | null> => {
    const query = new URLSearchParams({ date: params.date, crew_id: params.crewId }).toString();
    const response = await apiFetch<{ success: boolean; data: RouteOptimizationResult | null }>(`operations/route-plan?${query}`);
    return response.data ?? null;
  },
  reorderRoutePlan: async (routePlanId: string, stops: { jobId: string; order: number }[]): Promise<{ message: string }> => {
    const response = await apiFetch<{ success: boolean; message: string }>('operations/route-plan/reorder', {
      method: 'POST',
      body: JSON.stringify({ routePlanId, stops })
    });
    return { message: response.message || 'Route reordered' };
  },
  getAvailability: async (params: { startDate: string; endDate: string; crewId?: string }): Promise<CrewAvailabilitySummary[]> => {
    const queryParams = new URLSearchParams({
      start_date: params.startDate,
      end_date: params.endDate
    });
    if (params.crewId) {
      queryParams.append('crew_id', params.crewId);
    }
    const response = await apiFetch<{ success: boolean; data: CrewAvailabilitySummary[] }>(`operations/availability?${queryParams.toString()}`);
    return response.data ?? [];
  },
  getWeatherImpacts: async (params: { startDate: string; endDate: string; crewId?: string }): Promise<WeatherImpact[]> => {
    const queryParams = new URLSearchParams({
      start_date: params.startDate,
      end_date: params.endDate
    });
    if (params.crewId) {
      queryParams.append('crew_id', params.crewId);
    }
    const response = await apiFetch<{ success: boolean; data: WeatherImpact[] }>(`operations/weather-impacts?${queryParams.toString()}`);
    return response.data ?? [];
  },
  dispatchCrewNotifications: async (payload: { date: string; crewId?: string; channel?: 'sms' | 'push' | 'email' }): Promise<DispatchResult> => {
    const response = await apiFetch<{ success: boolean; data: DispatchResult }>('operations/dispatch-messages', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return response.data;
  },
  sendOnMyWay: async (payload: { jobId: string; crewId?: string; etaMinutes?: number; channel?: 'sms' | 'push' | 'email' }): Promise<{ message: string }> => {
    const response = await apiFetch<{ success: boolean; message: string }>('operations/on-my-way', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return { message: response.message || 'Customer notified' };
  }
};

export const aiService = {
  getJobDurationPrediction: async (jobId: string): Promise<AiJobDurationPrediction> => {
    const response = await apiFetch<{ success: boolean; data: AiJobDurationPrediction }>(`ai/jobs/${jobId}/duration`);
    return response.data;
  },
  getScheduleSuggestions: async (params: { date: string; crewId?: string }): Promise<{
    suggestions: AiSchedulingSuggestion[];
    predictions: AiJobDurationPrediction[];
  }> => {
    const query = new URLSearchParams({ date: params.date });
    if (params.crewId) query.append('crew_id', params.crewId);
    const response = await apiFetch<{ success: boolean; data: { suggestions: AiSchedulingSuggestion[]; predictions: AiJobDurationPrediction[] } }>(
      `ai/schedule-suggestions?${query.toString()}`
    );
    return response.data;
  },
  assessJobRisk: async (jobId: string): Promise<AiRiskAssessment> => {
    const response = await apiFetch<{ success: boolean; data: AiRiskAssessment }>(`ai/jobs/${jobId}/risk`);
    return response.data;
  },
  getQuoteRecommendations: async (quoteId: string): Promise<AiQuoteRecommendation> => {
    const response = await apiFetch<{ success: boolean; data: AiQuoteRecommendation }>(`ai/quotes/${quoteId}/recommendations`);
    return response.data;
  },
  getWorkflowRecommendations: async (): Promise<AiWorkflowRecommendation[]> => {
    const response = await apiFetch<{ success: boolean; data: AiWorkflowRecommendation[] }>('ai/workflows/recommendations');
    return response.data ?? [];
  },
  setAutomationAiMode: async (enabled: boolean): Promise<{ enabled: boolean; message?: string }> => {
    const response = await apiFetch<{ success: boolean; data: { enabled: boolean; message?: string } }>('ai/workflows/ai-mode', {
      method: 'POST',
      body: JSON.stringify({ enabled })
    });
    return response.data;
  }
};

export const jobSeriesService = {
  getAll: async (): Promise<RecurringJobSeries[]> => {
    const response = await apiFetch<{ success: boolean; data: RecurringJobSeries[] }>('job-series');
    return response.data ?? [];
  },
  getById: async (id: string): Promise<RecurringJobSeries> => {
    const response = await apiFetch<{ success: boolean; data: RecurringJobSeries }>(`job-series/${id}`);
    return response.data;
  },
  create: async (data: Partial<RecurringJobSeries>): Promise<RecurringJobSeries> => {
    const response = await apiFetch<{ success: boolean; data: RecurringJobSeries }>('job-series', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    return response.data;
  },
  update: async (id: string, data: Partial<RecurringJobSeries>): Promise<RecurringJobSeries> => {
    const response = await apiFetch<{ success: boolean; data: RecurringJobSeries }>(`job-series/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    return response.data;
  },
  remove: async (id: string): Promise<void> => {
    await apiFetch<{ success: boolean }>(`job-series/${id}`, { method: 'DELETE' });
  },
  getInstances: async (seriesId: string): Promise<RecurringJobInstance[]> => {
    const response = await apiFetch<{ success: boolean; data: RecurringJobInstance[] }>(`job-series/${seriesId}/instances`);
    return response.data ?? [];
  },
  generateInstances: async (seriesId: string, options?: { horizonDays?: number; untilDate?: string }): Promise<RecurringJobInstance[]> => {
    const response = await apiFetch<{ success: boolean; data: RecurringJobInstance[] }>(`job-series/${seriesId}/generate`, {
      method: 'POST',
      body: JSON.stringify(options || {})
    });
    return response.data ?? [];
  },
  convertInstance: async (seriesId: string, instanceId: string): Promise<{ job: Job; instance: RecurringJobInstance }> => {
    const response = await apiFetch<{ success: boolean; data: { job: Job; instance: RecurringJobInstance } }>(`job-series/${seriesId}/instances/${instanceId}/convert`, {
      method: 'POST'
    });
    return response.data;
  },
  updateInstanceStatus: async (seriesId: string, instanceId: string, status: RecurringJobInstance['status']): Promise<RecurringJobInstance> => {
    const response = await apiFetch<{ success: boolean; data: RecurringJobInstance }>(`job-series/${seriesId}/instances/${instanceId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    return response.data;
  }
};

export interface DashboardSummaryCounts {
  clients: number;
  leads: number;
  activeLeads: number;
  quotes: number;
  pendingQuotes: number;
  jobs: number;
  scheduledJobs: number;
  completedJobs: number;
  invoices: number;
  unpaidInvoices: number;
  employees: number;
  equipment: number;
}

export interface DashboardRecentActivity {
  recentLeads: number;
  recentJobs: number;
  overdueInvoices: number;
}

export interface DashboardRevenue {
  totalInvoiced: number;
  totalPaid: number;
  outstanding: number;
}

export interface DashboardSummary {
  counts: DashboardSummaryCounts;
  recentActivity: DashboardRecentActivity;
  revenue: DashboardRevenue;
}

export const dashboardService = {
  getSummary: async (): Promise<DashboardSummary> => {
    const response = await apiFetch<{ success: boolean; data: DashboardSummary }>('dashboard/summary');
    return response.data;
  }
};
