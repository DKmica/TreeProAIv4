import { PaginationParams, PaginatedResponse } from '../types/pagination';

export interface WorkflowTrigger {
  id?: string;
  workflow_id?: string;
  trigger_type: string;
  config: Record<string, any>;
  conditions: TriggerCondition[];
  trigger_order?: number;
  created_at?: string;
  updated_at?: string;
}

export interface TriggerCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'in' | 'not_in';
  value: string | number | boolean | string[];
}

export interface WorkflowAction {
  id?: string;
  workflow_id?: string;
  action_type: string;
  config: Record<string, any>;
  delay_minutes: number;
  action_order?: number;
  continue_on_error: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  is_active: boolean;
  is_template: boolean;
  template_category?: string;
  max_executions_per_day: number;
  cooldown_minutes: number;
  created_by?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  trigger_count?: number;
  action_count?: number;
  executions_24h?: number;
  triggers?: WorkflowTrigger[];
  actions?: WorkflowAction[];
  recentLogs?: AutomationLog[];
}

export interface AutomationLog {
  id: string;
  execution_id: string;
  workflow_id: string;
  workflow_name?: string;
  trigger_type?: string;
  action_type?: string;
  action_id?: string;
  triggered_by_entity_type?: string;
  triggered_by_entity_id?: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  input_data?: Record<string, any>;
  output_data?: Record<string, any>;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  created_at: string;
}

export interface AutomationLogStats {
  period_days: number;
  overall: {
    total_executions: number;
    successful: number;
    failed: number;
    skipped: number;
    success_rate: number;
    avg_duration_ms: number;
    max_duration_ms: number;
    min_duration_ms: number;
  };
  daily: Array<{
    date: string;
    total: number;
    successful: number;
    failed: number;
  }>;
  by_action_type: Array<{
    action_type: string;
    total: number;
    successful: number;
    failed: number;
    avg_duration_ms: number;
  }>;
  top_workflows: Array<{
    id: string;
    name: string;
    execution_count: number;
    successful: number;
    failed: number;
  }>;
}

export interface WorkflowExecutionResult {
  execution_id: string;
  workflow_id: string;
  status: string;
  started_at: string;
  logs: AutomationLog[];
}

export interface WorkflowsParams extends PaginationParams {
  status?: 'active' | 'inactive';
  include_templates?: boolean;
}

export interface AutomationLogsParams extends PaginationParams {
  workflow_id?: string;
  status?: 'running' | 'completed' | 'failed' | 'skipped';
  action_type?: string;
  entity_type?: string;
  entity_id?: string;
  start_date?: string;
  end_date?: string;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} - ${errorText}`);
  }
  
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  
  return response.json() as Promise<T>;
}

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `/api/${endpoint}`;
  const timeout = 10000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
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

function buildQueryString(params: Record<string, any>): string {
  const searchParams = new URLSearchParams();
  
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  
  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : '';
}

export const workflowService = {
  getWorkflows: async (params?: WorkflowsParams): Promise<PaginatedResponse<Workflow>> => {
    const queryParams: Record<string, any> = {};
    
    if (params?.page !== undefined) queryParams.page = params.page;
    if (params?.pageSize !== undefined) queryParams.pageSize = params.pageSize;
    if (params?.search) queryParams.search = params.search;
    if (params?.status) queryParams.status = params.status;
    if (params?.include_templates) queryParams.include_templates = 'true';
    
    const query = buildQueryString(queryParams);
    const response = await apiFetch<{ success: boolean; data: Workflow[]; pagination?: PaginatedResponse<Workflow>['pagination'] }>(`workflows${query}`);
    
    return {
      data: response.data ?? [],
      pagination: response.pagination || {
        total: response.data?.length ?? 0,
        page: params?.page ?? 1,
        pageSize: params?.pageSize ?? 20,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      }
    };
  },

  getWorkflow: async (id: string): Promise<Workflow> => {
    const response = await apiFetch<{ success: boolean; data: Workflow }>(`workflows/${id}`);
    return response.data;
  },

  createWorkflow: async (data: Partial<Workflow> & { triggers?: WorkflowTrigger[]; actions?: WorkflowAction[] }): Promise<Workflow> => {
    const response = await apiFetch<{ success: boolean; data: Workflow }>('workflows', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    return response.data;
  },

  updateWorkflow: async (id: string, data: Partial<Workflow> & { triggers?: WorkflowTrigger[]; actions?: WorkflowAction[] }): Promise<Workflow> => {
    const response = await apiFetch<{ success: boolean; data: Workflow }>(`workflows/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    return response.data;
  },

  deleteWorkflow: async (id: string): Promise<void> => {
    await apiFetch<{ success: boolean }>(`workflows/${id}`, {
      method: 'DELETE'
    });
  },

  toggleWorkflow: async (id: string): Promise<{ id: string; is_active: boolean }> => {
    const response = await apiFetch<{ success: boolean; data: { id: string; is_active: boolean } }>(`workflows/${id}/toggle`, {
      method: 'POST'
    });
    return response.data;
  },

  executeWorkflow: async (id: string, context?: { entityType?: string; entityId?: string; entityData?: Record<string, any> }): Promise<WorkflowExecutionResult> => {
    const response = await apiFetch<{ success: boolean; data: WorkflowExecutionResult }>(`workflows/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify(context || {})
    });
    return response.data;
  },

  getWorkflowTemplates: async (category?: string): Promise<Workflow[]> => {
    const query = category ? `?category=${encodeURIComponent(category)}` : '';
    const response = await apiFetch<{ success: boolean; data: Workflow[] }>(`workflows/templates${query}`);
    return response.data ?? [];
  },

  createFromTemplate: async (templateId: string, name?: string, description?: string): Promise<Workflow> => {
    const response = await apiFetch<{ success: boolean; data: Workflow }>(`workflows/from-template/${templateId}`, {
      method: 'POST',
      body: JSON.stringify({ name, description })
    });
    return response.data;
  }
};

export const automationLogService = {
  getLogs: async (params?: AutomationLogsParams): Promise<PaginatedResponse<AutomationLog>> => {
    const queryParams: Record<string, any> = {};
    
    if (params?.page !== undefined) queryParams.page = params.page;
    if (params?.pageSize !== undefined) queryParams.pageSize = params.pageSize;
    if (params?.workflow_id) queryParams.workflow_id = params.workflow_id;
    if (params?.status) queryParams.status = params.status;
    if (params?.action_type) queryParams.action_type = params.action_type;
    if (params?.entity_type) queryParams.entity_type = params.entity_type;
    if (params?.entity_id) queryParams.entity_id = params.entity_id;
    if (params?.start_date) queryParams.start_date = params.start_date;
    if (params?.end_date) queryParams.end_date = params.end_date;
    
    const query = buildQueryString(queryParams);
    const response = await apiFetch<{ success: boolean; data: AutomationLog[]; pagination?: PaginatedResponse<AutomationLog>['pagination'] }>(`automation-logs${query}`);
    
    return {
      data: response.data ?? [],
      pagination: response.pagination || {
        total: response.data?.length ?? 0,
        page: 1,
        pageSize: 10,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      }
    };
  },

  getLogDetails: async (executionId: string): Promise<{ execution_id: string; workflow_id: string; workflow_name: string; status: string; logs: AutomationLog[] }> => {
    const response = await apiFetch<{ success: boolean; data: any }>(`automation-logs/${executionId}`);
    return response.data;
  },

  getStats: async (days?: number, workflowId?: string): Promise<AutomationLogStats> => {
    const params: Record<string, any> = {};
    if (days) params.days = days;
    if (workflowId) params.workflow_id = workflowId;
    
    const query = buildQueryString(params);
    const response = await apiFetch<{ success: boolean; data: AutomationLogStats }>(`automation-logs/stats${query}`);
    return response.data;
  }
};

export const TRIGGER_TYPES = [
  { value: 'quote_sent', label: 'Quote Sent', description: 'Fires when a quote is sent to a customer' },
  { value: 'quote_approved', label: 'Quote Approved', description: 'Fires when a customer approves a quote' },
  { value: 'quote_declined', label: 'Quote Declined', description: 'Fires when a customer declines a quote' },
  { value: 'lead_converted', label: 'Lead Converted to Quote', description: 'Fires when a lead is converted to a quote' },
  { value: 'quote_converted', label: 'Quote Converted to Job', description: 'Fires when a quote is converted to a job' },
  { value: 'job_created', label: 'Job Created', description: 'Fires when a new job is created' },
  { value: 'job_scheduled', label: 'Job Scheduled', description: 'Fires when a job is scheduled' },
  { value: 'job_started', label: 'Job Started', description: 'Fires when a job is started' },
  { value: 'job_completed', label: 'Job Completed', description: 'Fires when a job is marked complete' },
  { value: 'job_cancelled', label: 'Job Cancelled', description: 'Fires when a job is cancelled' },
  { value: 'invoice_created', label: 'Invoice Created', description: 'Fires when an invoice is generated' },
  { value: 'invoice_sent', label: 'Invoice Sent', description: 'Fires when an invoice is sent' },
  { value: 'invoice_overdue', label: 'Invoice Overdue', description: 'Fires when an invoice becomes overdue' },
  { value: 'payment_received', label: 'Payment Received', description: 'Fires when a payment is recorded' },
  { value: 'lead_created', label: 'Lead Created', description: 'Fires when a new lead is created' },
  { value: 'client_created', label: 'Client Created', description: 'Fires when a new client is created' },
  { value: 'scheduled', label: 'Scheduled (Cron)', description: 'Fires on a schedule (daily, weekly, etc.)' }
];

export const ACTION_TYPES = [
  { value: 'send_email', label: 'Send Email', description: 'Send an email using a template' },
  { value: 'send_sms', label: 'Send SMS', description: 'Send an SMS notification' },
  { value: 'create_task', label: 'Create Task', description: 'Create a follow-up task' },
  { value: 'update_entity', label: 'Update Entity', description: 'Update a field on the entity' },
  { value: 'create_invoice', label: 'Create Invoice', description: 'Generate an invoice from a job' },
  { value: 'create_job', label: 'Create Job', description: 'Create a job from a quote' },
  { value: 'delete_source', label: 'Delete Source Record', description: 'Delete the triggering entity (e.g., delete lead after converting to quote)' },
  { value: 'send_notification', label: 'Send Notification', description: 'Send an in-app notification' },
  { value: 'webhook', label: 'Call Webhook', description: 'Call an external webhook URL' },
  { value: 'delay', label: 'Wait/Delay', description: 'Wait for a specified time before next action' }
];

export const CONDITION_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
  { value: 'in', label: 'In List' },
  { value: 'not_in', label: 'Not In List' }
];