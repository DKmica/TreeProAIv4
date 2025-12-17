import { GoogleGenAI, Type } from "@google/genai";
import { AICoreInsights, Lead, Job, Quote, Employee, Equipment, UpsellSuggestion, MaintenanceAdvice, PayrollRecord, TimeEntry, PayPeriod } from "../../types";

// Use environment variable injected by Vite
const geminiApiKey = (import.meta as any).env.VITE_GEMINI_API_KEY;

if (!geminiApiKey) {
    console.error("VITE_GEMINI_API_KEY is not set!");
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey as string });

const aiCoreSchema = {
    type: Type.OBJECT,
    properties: {
        businessSummary: { type: Type.STRING, description: "A brief, 1-2 sentence summary of the current business status." },
        leadScores: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    leadId: { type: Type.STRING },
                    customerName: { type: Type.STRING },
                    score: { type: Type.NUMBER, description: "Score from 1-100." },
                    reasoning: { type: Type.STRING },
                    recommendedAction: { type: Type.STRING, enum: ['Prioritize Follow-up', 'Standard Follow-up', 'Nurture'] }
                },
                required: ["leadId", "customerName", "score", "reasoning", "recommendedAction"]
            }
        },
        jobSchedules: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    quoteId: { type: Type.STRING },
                    customerName: { type: Type.STRING },
                    suggestedDate: { type: Type.STRING, description: "Suggested date in YYYY-MM-DD format." },
                    suggestedCrew: { type: Type.ARRAY, items: { type: Type.STRING } },
                    reasoning: { type: Type.STRING }
                },
                required: ["quoteId", "customerName", "suggestedDate", "suggestedCrew", "reasoning"]
            }
        },
        maintenanceAlerts: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    equipmentId: { type: Type.STRING },
                    equipmentName: { type: Type.STRING },
                    reasoning: { type: Type.STRING },
                    recommendedAction: { type: Type.STRING, enum: ['Schedule Service Immediately', 'Schedule Routine Check-up'] }
                },
                 required: ["equipmentId", "equipmentName", "reasoning", "recommendedAction"]
            }
        },
        payrollInsights: {
            type: Type.OBJECT,
            properties: {
                totalLaborCost: { type: Type.NUMBER, description: "Total labor costs for the analyzed period." },
                laborCostPercentage: { type: Type.NUMBER, description: "Labor cost as percentage of revenue." },
                overtimeCostImpact: { type: Type.NUMBER, description: "Total cost impact from overtime hours." },
                recommendations: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "Actionable recommendations for labor cost optimization and payroll management."
                }
            },
            required: ["totalLaborCost", "laborCostPercentage", "overtimeCostImpact", "recommendations"]
        }
    },
    required: ["businessSummary", "leadScores", "jobSchedules", "maintenanceAlerts", "payrollInsights"]
};

export const getAiCoreInsights = async (
    leads: Lead[],
    jobs: Job[],
    quotes: Quote[],
    employees: Employee[],
    equipment: Equipment[],
    payrollRecords: PayrollRecord[] = [],
    timeEntries: TimeEntry[] = [],
    payPeriods: PayPeriod[] = []
): Promise<AICoreInsights> => {

    const today = new Date().toISOString().split('T')[0];
    
    const totalRevenue = jobs.filter(j => j.status === 'completed').reduce((sum, job) => {
        const quote = quotes.find(q => q.id === job.quoteId);
        if (quote) {
            const total = quote.lineItems.filter(li => li.selected).reduce((s, li) => s + li.price, 0) + (quote.stumpGrindingPrice || 0);
            return sum + total;
        }
        return sum;
    }, 0);

    const currentPayPeriod = payPeriods.find(pp => pp.status === 'Open' || pp.status === 'Processing');
    const upcomingPayrollAmount = payrollRecords
        .filter(pr => currentPayPeriod && pr.payPeriodId === currentPayPeriod.id && !pr.paidAt)
        .reduce((sum, pr) => sum + pr.netPay, 0);

    const prompt = `
        You are the AI Core for TreePro AI, a business management platform for tree service companies. Your function is to analyze all operational data and provide actionable, intelligent insights to automate and optimize the business. Today's date is ${today}.

        Analyze the following business data:
        - All Leads: ${JSON.stringify(leads)}
        - All Jobs: ${JSON.stringify(jobs)}
        - All Quotes: ${JSON.stringify(quotes)}
        - All Employees: ${JSON.stringify(employees.map(e => ({id: e.id, name: e.name, jobTitle: e.jobTitle, payRate: e.payRate})))}
        - All Equipment: ${JSON.stringify(equipment)}
        - Payroll Records: ${JSON.stringify(payrollRecords)}
        - Time Entries: ${JSON.stringify(timeEntries)}
        - Pay Periods: ${JSON.stringify(payPeriods)}

        **Revenue Context:**
        - Total Revenue (Completed Jobs): $${totalRevenue.toFixed(2)}

        Based on this data, generate a JSON object with the following insights:
        1.  **businessSummary**: A brief, 1-2 sentence summary of the current business status. Mention any urgent items including payroll obligations.
        2.  **leadScores**: Analyze all leads with status 'New'. Score each lead from 1 to 100 based on potential value, urgency (keywords like 'emergency', 'ASAP'), and likelihood to convert. An 'Emergency Call' should have a very high score.
        3.  **jobSchedules**: Find all quotes with status 'Accepted' that do not yet have a corresponding job in the jobs list. For each, suggest an optimal schedule date (a weekday in the near future) and a crew assignment (list of employee names). Consider crew composition (e.g., a leader and groundsman). Provide reasoning for your suggestion.
        4.  **maintenanceAlerts**: Analyze the equipment list. Flag any equipment where status is 'Needs Maintenance'. Also, flag equipment where 'lastServiceDate' was more than 6 months ago from today's date (${today}). Provide a recommended action.
        5.  **payrollInsights**: Analyze the payroll data comprehensively:
            
            **Total Labor Costs:**
            - Calculate the total labor cost from all payroll records (sum of grossPay)
            - Include both regular and overtime costs
            
            **Labor Cost Percentage:**
            - Calculate labor costs as a percentage of total revenue
            - Industry standard for tree services is typically 30-35%
            - Provide context: "Labor costs are X% of revenue (target: 30-35%)"
            
            **Overtime Analysis:**
            - Calculate total overtime costs (sum of overtimePay from payroll records)
            - Identify overtime cost impact and trends
            - If overtime is high, recommend: "Overtime costs are $X,XXX - consider hiring additional crew members"
            
            **Employee Productivity:**
            - Calculate revenue per labor hour using time entries and completed jobs
            - Identify employee utilization rates
            - Suggest: "Employee utilization suggests capacity for X additional jobs" or "Crew is at capacity"
            
            **Upcoming Payroll Obligations:**
            - Identify upcoming payroll amounts that haven't been paid yet
            - Provide cash flow alerts: "Payroll processing upcoming for $${upcomingPayrollAmount.toFixed(2)} on [pay period end date]"
            
            **Recommendations:**
            Provide 3-5 actionable recommendations such as:
            - Labor cost optimization strategies
            - Overtime reduction suggestions (hiring, scheduling improvements)
            - Employee productivity improvements
            - Cash flow management for payroll
            - Comparison to industry benchmarks
            
            Return the payrollInsights object with:
            - totalLaborCost: number (sum of all gross pay)
            - laborCostPercentage: number (labor cost / revenue * 100)
            - overtimeCostImpact: number (total overtime costs)
            - recommendations: string[] (3-5 specific, actionable insights)

        Return ONLY a valid JSON object adhering to the provided schema. Do not include any other text or markdown formatting.
    `;
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: aiCoreSchema
            }
        });

        const cleanedJsonText = response.text.trim().replace(/^```json\s*|```$/g, '');
        return JSON.parse(cleanedJsonText) as AICoreInsights;

    } catch (error: any) {
        console.error("Error getting AI Core insights:", error);
        const errorMessage = error?.message || error?.toString() || "Unknown error";
        const errorDetails = error?.status ? ` (Status: ${error.status})` : '';
        throw new Error(`Failed to generate AI Core insights: ${errorMessage}${errorDetails}`);
    }
};

const upsellSchema = {
    type: Type.ARRAY,
    items: {
        type: Type.OBJECT,
        properties: {
            service_name: { type: Type.STRING, description: "A clear name for the suggested service (e.g., 'Stump Grinding', 'Debris Haul-Away')." },
            description: { type: Type.STRING, description: "A brief, customer-facing explanation of what the service entails." },
            suggested_price: { type: Type.NUMBER, description: "A reasonable, competitive price for this standalone service." }
        },
        required: ["service_name", "description", "suggested_price"]
    }
};

export const generateUpsellSuggestions = async (existingServices: string[]): Promise<UpsellSuggestion[]> => {
    const prompt = `
        You are an expert sales assistant for a tree care company. Based on the services already in a customer's quote, suggest relevant upsell or cross-sell opportunities.

        **Existing Services in Quote:**
        - ${existingServices.join('\n- ')}

        **Your Task:**
        Provide a list of 2-3 complementary services. For each suggestion:
        1.  Provide a clear service name.
        2.  Write a brief, compelling description for the customer.
        3.  Suggest a realistic price.

        **Common Upsell Pairings:**
        -   If "Tree Removal", suggest "Stump Grinding", "Debris Haul-Away", or "Soil/Grass Restoration".
        -   If "Tree Pruning" or "Trimming", suggest "Fertilization Treatment", "Cabling and Bracing" for weak branches, or "Pest/Disease Inspection".
        -   If "Emergency Service", suggest "Preventative Pruning for other trees" or "Comprehensive Property Safety Assessment".
        
        Do not suggest services that are already in the quote. Return ONLY a valid JSON array adhering to the provided schema. If there are no logical suggestions, return an empty array.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: upsellSchema
            }
        });
        const cleanedJsonText = response.text.trim().replace(/^```json\s*|```$/g, '');
        // Handle cases where the model might return an empty string for no suggestions
        if (!cleanedJsonText) {
            return [];
        }
        return JSON.parse(cleanedJsonText) as UpsellSuggestion[];
    } catch (error: any) {
        console.error("Error generating upsell suggestions:", error);
        const errorMessage = error?.message || error?.toString() || "Unknown error";
        throw new Error(`Failed to generate AI upsell suggestions: ${errorMessage}`);
    }
};

const maintenanceAdviceSchema = {
    type: Type.OBJECT,
    properties: {
        next_service_recommendation: {
            type: Type.STRING,
            description: "A concise, actionable recommendation for the next service and when it should be performed."
        },
        common_issues: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "A list of common issues or parts to check for this specific make and model."
        }
    },
    required: ["next_service_recommendation", "common_issues"]
};

export const generateMaintenanceAdvice = async (equipment: Equipment): Promise<MaintenanceAdvice> => {
    const prompt = `
        You are an expert equipment maintenance technician specializing in arboriculture machinery. Analyze the provided equipment data and its service history to give proactive maintenance advice.

        **Equipment Details:**
        - Name: ${equipment.name}
        - Make/Model: ${equipment.make} ${equipment.model}
        - Purchase Date: ${equipment.purchaseDate}
        - Last Service Date: ${equipment.lastServiceDate}
        - Maintenance History: ${JSON.stringify(equipment.maintenanceHistory, null, 2)}

        **Your Task:**
        1.  **Next Service Recommendation**: Based on the equipment type, age, and last service date, provide a clear, one-sentence recommendation for its next service. (e.g., "Recommend a full engine service with oil and filter change within the next 3 months or 50 operating hours.").
        2.  **Common Issues**: For this specific make and model (${equipment.make} ${equipment.model}), list 2-3 common issues or parts that wear out and should be inspected regularly. (e.g., "Check hydraulic hoses for cracks", "Inspect grinder teeth for wear and torque", "Ensure chipper blades are sharp and properly gapped").

        Return ONLY a valid JSON object adhering to the provided schema.
    `;
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: maintenanceAdviceSchema
            }
        });
        const cleanedJsonText = response.text.trim().replace(/^```json\s*|```$/g, '');
        return JSON.parse(cleanedJsonText) as MaintenanceAdvice;
    } catch (error: any) {
        console.error("Error generating maintenance advice:", error);
        const errorMessage = error?.message || error?.toString() || "Unknown error";
        throw new Error(`Failed to generate AI maintenance advice: ${errorMessage}`);
    }
};