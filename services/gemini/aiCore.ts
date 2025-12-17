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
  companyProfileService,
  addMaintenanceLog
} from "../apiService";

const geminiApiKey = (import.meta as any).env.VITE_GEMINI_API_KEY;

if (!geminiApiKey) {
  console.error("VITE_GEMINI_API_KEY is not set!");
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey as string });

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

let businessContext: BusinessContext | null = null;

function ensureContext(): BusinessContext {
  if (!businessContext) {
    throw new Error('AI Core context is not initialized.');
  }
  return businessContext;
}

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
  const lastName = parts.length > 0 ? parts.join(' ') : undefined;
  return {
    firstName: normalizeInputString(firstName),
    lastName: normalizeInputString(lastName)
  };
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

  if (nameParts.firstName) {
    details.firstName = nameParts.firstName;
  }
  if (nameParts.lastName) {
    details.lastName = nameParts.lastName;
  }

  const assignIfPresent = (key: keyof CustomerDetailsInput, value?: string | null) => {
    const normalized = normalizeInputString(value);
    if (normalized) {
      details[key] = normalized;
    }
  };

  assignIfPresent('companyName', input.companyName);
  assignIfPresent('email', input.email);
  assignIfPresent('phone', input.phone);
  assignIfPresent('addressLine1', input.addressLine1);
  assignIfPresent('addressLine2', input.addressLine2);
  assignIfPresent('city', input.city);
  assignIfPresent('state', input.state);
  assignIfPresent('zipCode', input.zipCode);
  assignIfPresent('country', input.country);

  return Object.keys(details).length > 0 ? details : undefined;
};

const buildCustomerDetailsFromClient = (client?: Client, fallbackName?: string): CustomerDetailsInput | undefined => {
  if (!client && !fallbackName) {
    return undefined;
  }

  return buildCustomerDetails({
    fullName: fallbackName || `${client?.firstName || ''} ${client?.lastName || ''}`,
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

const buildCustomerDetailsFromName = (name?: string): CustomerDetailsInput | undefined =>
  buildCustomerDetails({ fullName: name });

async function refreshClientsCache(): Promise<void> {
  if (!businessContext) return;

  try {
    const latestClients = await clientService.getAll();
    businessContext.clients = latestClients;
    businessContext.lastUpdated = new Date();
  } catch (error) {
    console.warn('Unable to refresh client list after mutation:', error);
  }
}

let chatSession: Chat | null = null;
let requestCount = 0;
let lastRequestTime = Date.now();
const RATE_LIMIT_PER_MINUTE = 15;
const RATE_LIMIT_WINDOW = 60000;

const ARBORIST_KNOWLEDGE = `
# Expert Arborist Knowledge Base

## Common Tree Species & Characteristics

### Oak Trees (Quercus)
- Height: 50-80 feet, Spread: 40-60 feet
- Growth Rate: Slow to medium
- Pruning Season: Late winter (dormant season)
- Common Issues: Oak wilt, powdery mildew, gypsy moths
- Removal Difficulty: High (dense, heavy wood)

### Maple Trees (Acer)
- Height: 40-75 feet, Spread: 30-50 feet
- Growth Rate: Medium to fast
- Pruning Season: Late summer to avoid bleeding
- Common Issues: Anthracnose, tar spot, verticillium wilt
- Removal Difficulty: Medium (moderate density)

### Pine Trees (Pinus)
- Height: 50-150 feet, Spread: 20-40 feet
- Growth Rate: Medium to fast
- Pruning Season: Late winter to early spring
- Common Issues: Pine beetles, needle blight, root rot
- Removal Difficulty: Medium (tall but lighter wood)

### Palm Trees (Arecaceae)
- Height: 10-80 feet, Spread: 10-20 feet
- Growth Rate: Slow to medium
- Pruning Season: Year-round (remove dead fronds)
- Common Issues: Lethal bronzing, bud rot, weevils
- Removal Difficulty: Medium (requires special equipment)

### Elm Trees (Ulmus)
- Height: 60-80 feet, Spread: 40-60 feet
- Growth Rate: Fast
- Pruning Season: Late winter
- Common Issues: Dutch elm disease, elm leaf beetle
- Removal Difficulty: High (large, spreading canopy)

### Birch Trees (Betula)
- Height: 40-70 feet, Spread: 25-35 feet
- Growth Rate: Fast
- Pruning Season: Late summer (bleeds heavily in spring)
- Common Issues: Bronze birch borer, leaf miners
- Removal Difficulty: Low to medium

## Pruning Techniques

### Crown Reduction
- Purpose: Reduce overall tree height/spread
- Method: Selective removal of branches back to lateral branches
- Ideal For: Trees interfering with structures, utility lines
- Timing: Species-dependent, typically dormant season

### Crown Thinning
- Purpose: Improve air circulation, reduce wind resistance
- Method: Selective removal of branches throughout crown
- Ideal For: Dense canopies, storm preparation
- Amount: Remove no more than 25% of living crown

### Crown Raising
- Purpose: Increase clearance beneath tree
- Method: Remove lower branches
- Ideal For: Pedestrian/vehicle clearance, lawn health
- Limit: Maintain live crown ratio of at least 2/3 tree height

### Structural Pruning
- Purpose: Develop strong tree architecture
- Method: Select and maintain central leader, remove competing stems
- Ideal For: Young trees, establishing permanent scaffold
- Critical Period: First 25 years of tree growth

## Safety Protocols

### Personal Protective Equipment (PPE)
- Hard hat with chin strap (ANSI Z89.1)
- Safety glasses or face shield
- Hearing protection (for chainsaw work)
- Chainsaw chaps (ASTM F1897)
- Steel-toe boots with good ankle support
- Work gloves (cut-resistant for chainsaw work)
- High-visibility clothing

### Power Line Clearance
- Minimum 10-foot clearance from power lines
- Call utility company for lines over 750 volts
- Never work within 10 feet without qualified line clearance arborist
- Treat all lines as energized until confirmed otherwise
- Use only non-conductive tools near power lines

### Rigging Safety
- Inspect all rigging equipment before each use
- Use proper rigging techniques (block and tackle, speedline)
- Calculate load weights and forces
- Establish drop zone and clear area
- Use tag lines to control falling pieces
- Never exceed working load limits of equipment

### Fall Protection
- Use fall arrest system when working above 6 feet
- Inspect harness and lanyard before each use
- Maintain 100% tie-in when climbing
- Use proper anchor points
- Keep fall distance to minimum

## Equipment Usage

### Chainsaws
- Bar Length Selection: 12-20" for pruning, 18-36" for felling
- Safety Features: Chain brake, throttle lock, anti-vibration
- Maintenance: Sharpen chain regularly, check tension, clean air filter
- Typical Cost: $300-$1,200 (professional grade)

### Wood Chippers
- Capacity: 6-12 inch diameter typical
- Safety: Feed material butt-first, stay clear of infeed
- Maintenance: Check/replace blades regularly, inspect belts
- Typical Cost: $8,000-$25,000 (tow-behind)

### Stump Grinders
- Types: Walk-behind, tow-behind, self-propelled
- Grinding Depth: Typically 6-18 inches below grade
- Safety: Clear area of debris, watch for underground utilities
- Typical Cost: $150-$400/day rental, $15,000-$50,000 purchase

### Aerial Lifts (Bucket Trucks)
- Types: Overcenter, non-overcenter
- Height Range: 29-75 feet typical
- Safety: Set outriggers on solid ground, use fall arrest
- Operator Certification Required: ANSI A92.2
- Typical Cost: $50,000-$150,000

### Climbing Equipment
- Saddle/Harness: Full-body harness preferred
- Rope: Static or semi-static, minimum 1/2" diameter
- Carabiners: Locking, rated for climbing
- Ascenders/Descenders: Mechanical advantage systems

## Seasonal Recommendations

### Spring (March-May)
- Best For: Planting new trees, fertilization
- Pruning: Most species (before leaf-out)
- Avoid: Pruning maples, birches (excessive bleeding)
- Services to Promote: Plant health care, mulching, fertilization

### Summer (June-August)
- Best For: Identifying structural issues, treating diseases
- Pruning: Minimal pruning, remove dead/hazardous branches only
- Avoid: Heavy pruning during heat stress
- Services to Promote: Emergency storm work, watering services

### Fall (September-November)
- Best For: Planting, preparing for winter
- Pruning: Light pruning acceptable
- Avoid: Heavy pruning before dormancy
- Services to Promote: Fall cleanup, tree assessment

### Winter (December-February)
- Best For: Major pruning, tree removal, dormant season work
- Pruning: Ideal time for most species (easy to see structure)
- Avoid: Pruning during extreme cold (below 20°F)
- Services to Promote: Hazard tree removal, structural pruning

## Common Tree Diseases & Pests

### Oak Wilt
- Symptoms: Wilting, browning leaves starting at top
- Treatment: Fungicide injection (preventative), remove infected trees
- Prevention: Avoid pruning during active months (April-July)

### Dutch Elm Disease
- Symptoms: Yellowing, wilting leaves on one branch, progressing
- Treatment: Remove infected trees, preventative fungicide injections
- Vector: Elm bark beetle

### Emerald Ash Borer
- Symptoms: D-shaped exit holes, canopy dieback, bark splitting
- Treatment: Systemic insecticide (imidacloprid, emamectin benzoate)
- Prevention: Annual treatments for valuable trees

### Gypsy Moth
- Symptoms: Severe defoliation in late spring/early summer
- Treatment: Bacillus thuringiensis (Bt), chemical insecticides
- Impact: Can kill trees after 2-3 years of defoliation

## Job Hazard Assessment Guidelines

Before each job, assess:

1. **Tree Condition**
   - Dead/dying limbs or tops
   - Decay, cavities, or cracks
   - Lean or imbalance
   - Root damage or soil heaving

2. **Site Hazards**
   - Power lines (primary hazard)
   - Structures (houses, garages, fences)
   - Underground utilities
   - Terrain (slopes, wet ground)
   - Traffic patterns

3. **Weather Conditions**
   - Wind speed (avoid working in winds >20 mph)
   - Lightning risk
   - Temperature extremes
   - Recent rain (slippery conditions)

4. **Equipment Needs**
   - Proper size chainsaw for job
   - Rigging equipment for controlled lowering
   - Aerial lift vs. climbing access
   - Personal protective equipment

5. **Crew Requirements**
   - Minimum 2-person crew for climbing
   - Qualified arborist for complex removals
   - Ground personnel for traffic control
   - First aid/CPR certified crew member

## Estimating Guidelines

### Tree Removal Pricing Factors
- Tree height and diameter
- Proximity to structures/obstacles
- Wood disposal/haul-away
- Stump grinding (additional service)
- Access and terrain difficulty
- Cleanup and site restoration

### Typical Price Ranges
- Small tree removal (under 30'): $300-$800
- Medium tree removal (30-60'): $800-$2,500
- Large tree removal (over 60'): $2,500-$8,000+
- Hazardous/complex removals: Add 50-200%
- Stump grinding: $100-$400 per stump
- Emergency services: 1.5-3x normal rates

### Hourly Rates by Position
- Certified Arborist: $50-$75/hour
- Climber: $35-$55/hour
- Groundsman: $20-$35/hour
- Equipment operator: $40-$60/hour
`;

const functionDeclarations: FunctionDeclaration[] = [
  // ... existing code ...
  {
    name: 'updateJobStatus',
    description: 'Update the status of a job.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobId: { type: Type.STRING, description: 'ID of the job' },
        status: {
          type: Type.STRING,
          description: 'New job status',
          enum: ['unscheduled', 'scheduled', 'in_progress', 'completed', 'cancelled']
        }
      },
      required: ['jobId', 'status']
    }
  },
  // ... existing code ...
  {
    name: 'getJobsByStatus',
    description: 'Retrieve all jobs filtered by status.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description: 'Job status to filter by',
          enum: ['unscheduled', 'scheduled', 'in_progress', 'completed', 'cancelled']
        }
      },
      required: ['status']
    }
  },
  // ... existing code ...
];

async function checkRateLimit(): Promise<void> {
  const now = Date.now();
  if (now - lastRequestTime > RATE_LIMIT_WINDOW) {
    requestCount = 0;
    lastRequestTime = now;
  }

  if (requestCount >= RATE_LIMIT_PER_MINUTE) {
    const waitTime = RATE_LIMIT_WINDOW - (now - lastRequestTime);
    console.warn(`Rate limit reached. Waiting ${waitTime}ms...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    requestCount = 0;
    lastRequestTime = Date.now();
  }

  requestCount++;
}

function getContextSummary(): string {
  if (!businessContext) {
    return JSON.stringify({ summary: "AI Core is not yet initialized." });
  }

  const ctx = businessContext;
  
  const quotes = Array.isArray(ctx.quotes) ? ctx.quotes : [];
  const invoices = Array.isArray(ctx.invoices) ? ctx.invoices : [];
  
  return JSON.stringify({
    summary: {
      totalCustomers: ctx.clients.length,
      totalLeads: ctx.leads.length,
      newLeads: ctx.leads.filter(l => l.status === 'New').length,
      totalQuotes: quotes.length,
      acceptedQuotes: quotes.filter(q => q.status === 'Accepted').length,
      totalJobs: ctx.jobs.length,
      scheduledJobs: ctx.jobs.filter(j => j.status === 'scheduled').length,
      inProgressJobs: ctx.jobs.filter(j => j.status === 'in_progress').length,
      completedJobs: ctx.jobs.filter(j => j.status === 'completed').length,
      totalEmployees: ctx.employees.length,
      totalEquipment: ctx.equipment.length,
      operationalEquipment: ctx.equipment.filter(e => e.status === 'Operational').length,
      needsMaintenanceEquipment: ctx.equipment.filter(e => e.status === 'Needs Maintenance').length,
      totalInvoices: invoices.length,
      unpaidInvoices: invoices.filter(i => i.status !== 'Paid').length,
      companyName: ctx.companyProfile?.companyName || 'Tree Service Company'
    },
    clients: ctx.clients.slice(0, 10).map(c => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, companyName: c.companyName })),
    leads: ctx.leads.map(l => ({ id: l.id, customer: l.customer.name, status: l.status, source: l.source, description: l.description })),
    quotes: quotes.map(q => ({ id: q.id, customerName: q.customerName, status: q.status, leadId: q.leadId })),
    jobs: ctx.jobs.map(j => ({ id: j.id, customerName: j.customerName, status: j.status, scheduledDate: j.scheduledDate, assignedCrew: j.assignedCrew })),
    employees: ctx.employees.map(e => ({ id: e.id, name: e.name, jobTitle: e.jobTitle, payRate: e.payRate })),
    equipment: ctx.equipment.map(eq => ({ id: eq.id, name: eq.name, status: eq.status, lastServiceDate: eq.lastServiceDate })),
    invoices: invoices.map(i => ({ id: i.id, customerName: i.customerName, status: i.status, amount: i.amount }))
  }, null, 2);
}

function getSystemInstruction(): string {
  return `You are the AI Core assistant for TreePro AI, a comprehensive business management platform for tree service companies.

# Your Capabilities

You have access to complete business data and can:
1. Answer questions about customers, leads, quotes, jobs, employees, equipment, and finances
2. Execute actions through function calling (create records, update statuses, schedule jobs, etc.)
3. Provide expert arborist knowledge and recommendations
4. Guide users through features and workflows
5. Analyze business metrics and suggest optimizations

# Current Business Context

${getContextSummary()}

# Expert Arborist Knowledge

${ARBORIST_KNOWLEDGE}

# Conversation Guidelines

- Be conversational, helpful, and proactive
- When asked to perform actions, use the appropriate function calls
- Provide detailed explanations with your arborist expertise
- Reference specific data from the business context when relevant
- Suggest next steps and opportunities
- If you need to navigate or create something, use the function calls available
- Always confirm actions before executing destructive operations
- Format responses clearly with proper formatting when showing data

# Function Calling

When the user asks you to do something actionable (create, update, navigate, etc.), use the appropriate function call. You have access to 60+ functions covering:
- Navigation (navigateTo, openRecord)
- Customer/Lead management (createCustomer, createLead, updateLeadStatus, etc.)
- Quote/Job management (createQuote, convertQuoteToJob, updateJobStatus, etc.)
- Financial operations (getRevenueForPeriod, generateInvoice, getOutstandingInvoices, etc.)
- Employee/Payroll (trackTime, processPayroll, getPayrollSummary, getTimeTrackingStatus, etc.)
- Equipment (scheduleMaintenance, assignEquipment, getAvailableEquipment, etc.)
- Analytics (getBusinessMetrics, getLeadConversionRate, getEstimatorAccuracy, etc.)
- Client data (getClientProperties, getClientContacts)
- Crew management (getCrewSchedule, assignCrewToJob, getCrewUtilization, etc.)
- Marketing (getMarketingStatus, createPromotionalCampaign, trackReferralSourceROI, etc.)
- Exception management (getExceptionQueue - pending approvals, overdue items)
- Help/Onboarding (startOnboarding, getFeatureHelp, suggestNextSteps)

Remember: You are the intelligent assistant that makes TreePro AI feel magical and helpful!
`;

async function executeFunctionCall(name: string, args: any): Promise<any> {
  console.log(`Executing function: ${name}`, args);

  const businessContext = ensureContext();

  try {
    switch (name) {
      // ... existing code ...
      case 'updateJobStatus':
        const updatedJob = await jobService.update(args.jobId, { status: args.status.toLowerCase() });
        const jobIndex = businessContext.jobs.findIndex(j => j.id === args.jobId);
        if (jobIndex >= 0) businessContext.jobs[jobIndex] = updatedJob;
        return { success: true, job: updatedJob, message: `Updated job status to ${args.status}` };

      case 'getJobsByStatus':
        const filteredJobs = businessContext.jobs.filter(j => j.status === args.status.toLowerCase());
        return { success: true, jobs: filteredJobs, count: filteredJobs.length };

      // ... existing code ...
    }
  } catch (error: any) {
    console.error(`Error executing function ${name}:`, error);
    return { success: false, message: `Error: ${error.message}` };
  }
}

async function initialize(initialData: BusinessContext): Promise<void> {
  businessContext = initialData;
  chatSession = ai.chats.create({
    model: 'gemini-2.0-flash',
    config: {
      systemInstruction: getSystemInstruction(),
      tools: [{ functionDeclarations }]
    }
  });
  console.log('✅ AI Core initialized with initial business context');
}

async function getRagContext(query: string): Promise<string> {
  try {
    const response = await fetch('/api/rag/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, maxResults: 8 })
    });

    if (!response.ok) {
      console.warn('RAG context fetch failed:', response.status);
      return '';
    }

    const data = await response.json();
    return data.context || '';
  } catch (error) {
    console.warn('RAG context unavailable:', error);
    return '';
  }
}

async function chat(message: string, history: ChatMessage[] = []): Promise<{ response: string; functionCalls?: any[] }> {
  await checkRateLimit();

  ensureContext();

  if (!chatSession) {
    chatSession = ai.chats.create({
      model: 'gemini-2.0-flash',
      config: {
        systemInstruction: getSystemInstruction(),
        tools: [{ functionDeclarations }]
      }
    });
  }

  try {
    const ragContext = await getRagContext(message);
    
    const enrichedMessage = ragContext 
      ? `User Question: ${message}\n\n---\nContext from Vector Database (use this data to answer accurately):\n${ragContext}\n---`
      : message;

    console.log('🔍 RAG Context:', ragContext ? 'Added' : 'Not available');
    
    const result = await chatSession!.sendMessage({ message: enrichedMessage });
    
    let responseText = '';
    const functionCalls: any[] = [];

    for (const part of result.functionCalls || []) {
      const functionResult = await executeFunctionCall(part.name, part.args);
      functionCalls.push({
        name: part.name,
        args: part.args,
        result: functionResult
      });

      await chatSession!.sendMessage({
        message: JSON.stringify({
          functionResponse: {
            name: part.name,
            response: functionResult
          }
        })
      });
    }

    if (functionCalls.length > 0) {
      const followUpResult = await chatSession!.sendMessage({ message: '' });
      responseText = followUpResult.text;
    } else {
      responseText = result.text;
    }

    return {
      response: responseText,
      functionCalls: functionCalls.length > 0 ? functionCalls : undefined
    };
  } catch (error: any) {
    console.error('Error in AI Core chat:', error);
    throw new Error(`AI Core chat error: ${error.message}`);
  }
}

async function refresh(newData: BusinessContext): Promise<void> {
  businessContext = newData;
  if (chatSession) {
    chatSession = ai.chats.create({
      model: 'gemini-2.0-flash',
      config: {
        systemInstruction: getSystemInstruction(),
        tools: [{ functionDeclarations }]
      }
    });
  }
  console.log('✅ AI Core data refreshed');
}

function getContext(): BusinessContext | null {
  return businessContext;
}

function isInitialized(): boolean {
  return businessContext !== null;
}

export const aiCore = {
  initialize,
  chat,
  refresh,
  getContext,
  isInitialized,
};

export default aiCore;