import { GoogleGenAI, Chat, FunctionDeclaration, Type } from "@google/genai";

let requestCount = 0;
let lastRequestTime = Date.now();
const RATE_LIMIT_PER_MINUTE = 15;
const RATE_LIMIT_WINDOW = 60_000;

export async function checkRateLimit(): Promise<void> {
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

export function buildSystemInstruction(getContextSummary: () => string, arboristKnowledge: string): string {
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
${arboristKnowledge}

# Guidelines
- Be conversational and helpful
- Use function calls for actionable requests
- Reference business context when relevant
- Confirm destructive operations
`;
}

export function createFunctionDeclarations(): FunctionDeclaration[] {
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

export function createChatSession(ai: GoogleGenAI, systemInstruction: string, functionDeclarations: FunctionDeclaration[]): Chat {
  return ai.chats.create({
    model: "gemini-2.0-flash",
    config: {
      systemInstruction,
      tools: [{ functionDeclarations }]
    }
  });
}

export async function getRagContext(query: string): Promise<string> {
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