import { GoogleGenAI, Chat } from "@google/genai";
import {
  Client,
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
import { jobService } from "../apiService";
import {
  buildSystemInstruction,
  createFunctionDeclarations,
  createChatSession,
  getRagContext,
  checkRateLimit
} from "./aiCoreUtils";

const geminiApiKey = (import.meta as any).env.VITE_GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error("VITE_GEMINI_API_KEY is not set!");
}
const ai = new GoogleGenAI({ apiKey: geminiApiKey as string });

export interface BusinessContext {
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
      clients: ctx.clients.slice(0, 10).map((c) => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        companyName: c.companyName
      })),
      leads: ctx.leads.map((l) => ({
        id: l.id,
        customer: l.customer.name,
        status: l.status,
        source: l.source,
        description: l.description
      })),
      quotes: quotes.map((q) => ({
        id: q.id,
        customerName: q.customerName,
        status: q.status,
        leadId: q.leadId
      })),
      jobs: ctx.jobs.map((j) => ({
        id: j.id,
        customerName: j.customerName,
        status: j.status,
        scheduledDate: j.scheduledDate,
        assignedCrew: j.assignedCrew
      })),
      employees: ctx.employees.map((e) => ({
        id: e.id,
        name: e.name,
        jobTitle: e.jobTitle,
        payRate: e.payRate
      })),
      equipment: ctx.equipment.map((eq) => ({
        id: eq.id,
        name: eq.name,
        status: eq.status,
        lastServiceDate: eq.lastServiceDate
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        customerName: i.customerName,
        status: i.status,
        amount: i.amount
      }))
    },
    null,
    2
  );
}

const ARBORIST_KNOWLEDGE = `
# Expert Arborist Knowledge Base
...snip...
`;

async function executeFunctionCall(name: string, args: any): Promise<any> {
  const ctx = ensureContext();
  switch (name) {
    case "updateJobStatus": {
      const updatedJob = await jobService.update(args.jobId, {
        status: String(args.status).toLowerCase() as any
      });
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
}

async function buildSession(): Promise<Chat> {
  const systemInstruction = buildSystemInstruction(getContextSummary, ARBORIST_KNOWLEDGE);
  const functionDeclarations = createFunctionDeclarations();
  return createChatSession(ai, systemInstruction, functionDeclarations);
}

async function initialize(initialData: BusinessContext): Promise<void> {
  setContext(initialData);
  chatSession = await buildSession();
  console.log("✅ AI Core initialized with context");
}

async function chat(message: string, history: ChatMessage[] = []): Promise<{ response: string; functionCalls?: any[] }> {
  await checkRateLimit();
  ensureContext();

  if (!chatSession) {
    chatSession = await buildSession();
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
  chatSession = await buildSession();
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