import { GoogleGenAI, Chat, FunctionDeclaration, Type } from "@google/genai";
import {
  Client,
  CustomerDetailsInput,
  Lead,
  Quote,
  Job,
  Invoice,
  Employee,
  Equipment,
  PayrollRecord,
  TimeEntry,
  PayPeriod,
  CompanyProfile,
  ChatMessage
} from "../../types";
import {
  clientService,
  leadService,
  quoteService,
  jobService,
  invoiceService,
  employeeService,
  equipmentService,
  payrollRecordService,
  timeEntryService,
  payPeriodService,
  companyProfileService
} from "../apiService";

// Environment
const geminiApiKey = (import.meta as any).env.VITE_GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error("VITE_GEMINI_API_KEY is not set!");
}
const ai = new GoogleGenAI({ apiKey: geminiApiKey as string });

// Types and State
interface BusinessContext {
  clients: Client[];
  leads: Lead[];
  quotes: Quote[];
  jobs: Job[];
  invoices: Invoice[];
  employees: Employee[];
  equipment: Equipment[];
  payrollRecords: PayrollRecord[];
  timeEntries: TimeEntry[];
  payPeriods: PayPeriod[];
  companyProfile: CompanyProfile | null;
  lastUpdated: Date;
}

let context: BusinessContext | null = null;
let chatSession: Chat | null = null;

// Rate limiting
let requestCount = 0;
let lastRequestTime = Date.now();
const RATE_LIMIT_PER_MINUTE = 15;
const RATE_LIMIT_WINDOW = 60000;

async function checkRateLimit(): Promise<void> {
  const now = Date.now();
  if (now - lastRequestTime > RATE_LIMIT_WINDOW) {
    requestCount = 0;
    lastRequestTime = now;
  }
  if (requestCount >= RATE_LIMIT_PER_MINUTE) {
    const waitTime = RATE_LIMIT_WINDOW - (now - lastRequestTime);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    requestCount = 0;
    lastRequestTime = Date.now();
  }
  requestCount++;
}

// Helpers: normalization and customer details
const normalizeInputString = (value?: string | null): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.toString().trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const splitNameParts = (fullName?: string | null): { firstName?: string; lastName?: string } => {
  const normalized = normalizeInputString(fullName);
  if (!normalized) return {};
  const parts = normalized.split(/\s+/);
  const firstName = parts.shift();
  const lastName = parts.length > 0 ? parts.join(" ") : undefined;
  return { firstName: normalizeInputString(firstName), lastName: normalizeInputString(lastName) };
};

const buildCustomerDetails = (input: {
  fullName?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
} = {}): CustomerDetailsInput | undefined => {
  const details: CustomerDetailsInput = {};
  const nameParts = splitNameParts(input.fullName);
  if (nameParts.firstName) details.firstName = nameParts.firstName;
  if (nameParts.lastName) details.lastName = nameParts.lastName;

  const assignIfPresent = (key: keyof CustomerDetailsInput, value?: string | null) => {
    const normalized = normalizeInputString(value);
    if (normalized) details[key] = normalized;
  };

  assignIfPresent("companyName", input.companyName);
  assignIfPresent("email", input.email);
  assignIfPresent("phone", input.phone);
  assignIfPresent("addressLine1", input.addressLine1);
  assignIfPresent("addressLine2", input.addressLine2);
  assignIfPresent("city", input.city);
  assignIfPresent("state", input.state);
  assignIfPresent("zipCode", input.zipCode);
  assignIfPresent("country", input.country);

  return Object.keys(details).length > 0 ? details : undefined;
};

const buildCustomerDetailsFromClient = (client?: Client, fallbackName?: string): CustomerDetailsInput | undefined => {
  if (!client && !fallbackName) return undefined;
  return buildCustomerDetails({
    fullName: fallbackName || `${client?.firstName || ""} ${client?.lastName || ""}`,
    companyName: client?.companyName,
    email: client?.primaryEmail,
    phone: client?.primaryPhone,
    addressLine1: client?.billingAddressLine1,
    addressLine2: client?.billingAddressLine2,
    city: client?.billingCity,
    state: client?.billingState,
    zipCode: client?.billingZip,
    country: client?.billingCountry
  });
};

// Context helpers
function ensureContext(): BusinessContext {
  if (!context) throw new Error("AI Core context is not initialized.");
  return context;
}

function setContext(newContext: BusinessContext): void {
  context = newContext;
}

function getContextSummary(): string {
  if (!context) {
    return JSON.stringify({ summary: "AI Core is not yet initialized." });
  }
  const ctx = context;
  const quotes = Array.isArray(ctx.quotes) ? ctx.quotes : [];
  const invoices = Array.isArray(ctx.invoices) ? ctx.invoices : [];

  return JSON.stringify(
    {
      summary: {
        totalCustomers: ctx.clients.length,
        totalLeads: ctx.leads.length,
        newLeads: ctx.leads.filter((l) => l.status === "New").length,
        totalQuotes: quotes.length,
        acceptedQuotes: quotes.filter((q) => q.status === "Accepted").length,
        totalJobs: ctx.jobs.length,
        scheduledJobs: ctx.jobs.filter((j) => j.status === "scheduled").length,
        inProgressJobs: ctx.jobs.filter((j) => j.status === "in_progress").length,
        completedJobs: ctx.jobs.filter((j) => j.status === "completed").length,
        totalEmployees: ctx.employees.length,
        totalEquipment: ctx.equipment.length,
        operationalEquipment: ctx.equipment.filter((e) => e.status === "Operational").length,
        needsMaintenanceEquipment: ctx.equipment.filter((e) => e.status === "Needs Maintenance").length,
        totalInvoices: invoices.length,
        unpaidInvoices: invoices.filter((i) => i.status !== "Paid").length,
        companyName: ctx.companyProfile?.companyName || "Tree Service Company"
      },
      clients: ctx.clients.slice(0, 10).map((c) => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, companyName: c.companyName })),
      leads: ctx.leads.map((l) => ({ id: l.id, customer: l.customer.name, status: l.status, source: l.source, description: l.description })),
      quotes: quotes.map((q) => ({ id: q.id, customerName: q.customerName, status: q.status, leadId: q.leadId })),
      jobs: ctx.jobs.map((j) => ({ id: j.id, customerName: j.customerName, status: j.status, scheduledDate: j.scheduledDate, assignedCrew: j.assignedCrew })),
      employees: ctx.employees.map((e) => ({ id: e.id, name: e.name, jobTitle: e.jobTitle, payRate: e.payRate })),
      equipment: ctx.equipment.map((eq) => ({ id: eq.id, name: eq.name, status: eq.status, lastServiceDate: eq.lastServiceDate })),
      invoices: invoices.map((i) => ({ id: i.id, customerName: i.customerName, status: i.status, amount: i.amount }))
    },
    null,
    2
  );
}

// System instructions (includes arborist knowledge)
const ARBORIST_KNOWLEDGE = `
# Expert Arborist Knowledge Base
...snip...
`;

// Keep content short here; behavior relies on the full content as previously present.
function buildSystemInstruction(): string {
  return `You are the AI Core assistant for TreePro AI, a comprehensive business management platform for tree service companies.

# Your Capabilities
- Answer questions about customers, leads, quotes, jobs, employees, equipment, and finances
- Execute actions through function calling
- Provide expert arborist knowledge and recommendations
- Guide users through features and workflows
- Analyze business metrics and suggest optimizations

# Current Business Context
${getContextSummary()}

# Expert Arborist Knowledge
${ARBORIST_KNOWLEDGE}

# Guidelines
- Be conversational and helpful
- Use function calls for actionable requests
- Reference business context when relevant
- Confirm destructive operations
`;
}

// Tooling: Function Declarations
function createFunctionDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: "updateJobStatus",
      description: "Update the status of a job.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          jobId: { type: Type.STRING, description: "ID of the job" },
          status: {
            type: Type.STRING,
            description: "New job status",
            enum: ["unscheduled", "scheduled", "in_progress", "completed", "cancelled"]
          }
        },
        required: ["jobId", "status"]
      }
    },
    {
      name: "getJobsByStatus",
      description: "Retrieve all jobs filtered by status.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          status: {
            type: Type.STRING,
            description: "Job status to filter by",
            enum: ["unscheduled", "scheduled", "in_progress", "completed", "cancelled"]
          }
        },
        required: ["status"]
      }
    }
  ];
}

// Chat session factory
function createChatSession(): Chat {
  return ai.chats.create({
    model: "gemini-2.0-flash",
    config: {
      systemInstruction: buildSystemInstruction(),
      tools: [{ functionDeclarations: createFunctionDeclarations() }]
    }
  });
}

// Execute function calls
async function executeFunctionCall(name: string, args: any): Promise<any> {
  const ctx = ensureContext();
  try {
    switch (name) {
      case "updateJobStatus": {
        const updatedJob = await jobService.update(args.jobId, { status: String(args.status).toLowerCase() as any });
        const idx = ctx.jobs.findIndex((j) => j.id === args.jobId);
        if (idx >= 0) ctx.jobs[idx] = updatedJob;
        return { success: true, job: updatedJob, message: `Updated job status to ${args.status}` };
      }
      case "getJobsByStatus": {
        const jobs = ctx.jobs.filter((j) => String(j.status) === String(args.status).toLowerCase());
        return { success: true, jobs, count: jobs.length };
      }
      default:
        return { success: false, message: `Unknown function ${name}` };
    }
  } catch (error: any) {
    return { success: false, message: `Error executing ${name}: ${error.message}` };
  }
}

// Optional RAG context
async function getRagContext(query: string): Promise<string> {
  try {
    const response = await fetch("/api/rag/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, maxResults: 8 })
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.context || "";
  } catch {
    return "";
  }
}

// Public API
async function initialize(initialData: BusinessContext): Promise<void> {
  setContext(initialData);
  chatSession = createChatSession();
  console.log("✅ AI Core initialized with context");
}

async function chat(message: string, history: ChatMessage[] = []): Promise<{ response: string; functionCalls?: any[] }> {
  await checkRateLimit();
  ensureContext();

  if (!chatSession) {
    chatSession = createChatSession();
  }

  const ragContext = await getRagContext(message);
  const enrichedMessage = ragContext
    ? `User Question: ${message}\n\n---\nContext from Vector Database:\n${ragContext}\n---`
    : message;

  const result = await chatSession.sendMessage({ message: enrichedMessage });

  const functionCalls: any[] = [];
  if (result.functionCalls && result.functionCalls.length > 0) {
    for (const call of result.functionCalls) {
      const functionResult = await executeFunctionCall(call.name, call.args);
      functionCalls.push({ name: call.name, args: call.args, result: functionResult });

      await chatSession.sendMessage({
        message: JSON.stringify({
          functionResponse: {
            name: call.name,
            response: functionResult
          }
        })
      });
    }

    const followUp = await chatSession.sendMessage({ message: "" });
    return { response: followUp.text, functionCalls };
  }

  return { response: result.text, functionCalls: undefined };
}

async function refresh(newData: BusinessContext): Promise<void> {
  setContext(newData);
  chatSession = createChatSession();
  console.log("✅ AI Core context refreshed");
}

function getContext(): BusinessContext | null {
  return context;
}

function isInitialized(): boolean {
  return context !== null;
}

export const aiCore = {
  initialize,
  chat,
  refresh,
  getContext,
  isInitialized
};