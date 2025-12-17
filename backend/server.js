const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const { setupAuth, isAuthenticated, getUser } = require('./auth');
const { applyStandardMiddleware } = require('./config/express');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const ragService = require('./services/ragService');
const vectorStore = require('./services/vectorStore');
const jobStateService = require('./services/jobStateService');
const jobTemplateService = require('./services/jobTemplateService');
const operationsService = require('./services/operationsService');
const recurringJobsService = require('./services/recurringJobsService');
const stripeService = require('./services/stripeService');
const automationService = require('./services/automationService');
const reminderService = require('./services/reminderService');
const { initializeAutomationEngine, shutdownAutomationEngine, emitBusinessEvent } = require('./services/automation');
const { generateJobNumber } = require('./services/numberService');
const { getStripeSecretKey, getStripeWebhookSecret } = require('./stripeClient');
const { mountApiRoutes } = require('./routes');
const { camelToSnake, snakeToCamel, sanitizeUUID } = require('./utils/formatters');
const userManagement = require('./controllers/userManagementController');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

let server;
let reminderInterval;

// SECURITY: Cache Stripe secrets at server initialization to prevent fetching on each webhook request.
// This ensures webhook verification fails fast if secrets are unavailable, preventing potential
// security vulnerabilities where forged webhooks could be processed if credential fetching fails.
let cachedStripeSecretKey = null;
let cachedWebhookSecret = null;
let stripeInitialized = false;

async function initStripe() {
  try {
    console.log('🔄 Fetching and caching Stripe credentials...');
    cachedStripeSecretKey = await getStripeSecretKey();
    cachedWebhookSecret = await getStripeWebhookSecret();

    if (!cachedStripeSecretKey || !cachedWebhookSecret) {
      console.warn('⚠️ Stripe keys are not fully configured. Payment features will be disabled.');
      cachedStripeSecretKey = null;
      cachedWebhookSecret = null;
      stripeInitialized = false;
      return false;
    }

    console.log('✅ Stripe credentials cached');
    stripeInitialized = true;
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Stripe:', error.message);
    console.warn('⚠️ Continuing without Stripe integration. Payment features will be unavailable.');
    cachedStripeSecretKey = null;
    cachedWebhookSecret = null;
    stripeInitialized = false;
    return false;
  }
}

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    
    if (!signature) {
      console.error('❌ Webhook error: Missing stripe-signature header');
      return res.status(400).json({ error: 'Missing stripe-signature' });
    }
    
    // SECURITY: Check if Stripe is initialized before processing any webhooks.
    // This prevents security vulnerabilities where webhooks could be processed
    // with null secrets, potentially allowing forged webhooks through.
    if (!stripeInitialized) {
      console.error('⚠️ Stripe webhook called but Stripe not initialized');
      return res.status(503).json({ error: 'Stripe not initialized' });
    }
    
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      
      if (!Buffer.isBuffer(req.body)) {
        const errorMsg = 'STRIPE WEBHOOK ERROR: req.body is not a Buffer. ' +
          'This means express.json() ran before this webhook route.';
        console.error(errorMsg);
        return res.status(500).json({ error: 'Webhook processing error' });
      }

      // SECURITY: Use cached secrets instead of fetching on each request.
      // This prevents security vulnerabilities where credential fetch failures could
      // allow forged webhooks to be processed. Fail fast if secrets aren't initialized.
      if (!cachedWebhookSecret || !cachedStripeSecretKey) {
        console.error('❌ CRITICAL: Webhook secret not initialized. Rejecting webhook.');
        return res.status(503).json({ error: 'Webhook secret not initialized' });
      }

      const stripe = require('stripe')(cachedStripeSecretKey);
      const event = stripe.webhooks.constructEvent(req.body, sig, cachedWebhookSecret);

      console.log(`📨 Stripe webhook received: ${event.type}`);

      // CUSTOMER ID PERSISTENCE: Customer IDs are persisted here in the webhook handler
      // rather than in the checkout endpoint. This is the safer approach because:
      // 1. The webhook only fires after Stripe confirms successful checkout session completion
      // 2. This prevents orphaned Stripe customer references if checkout fails
      // 3. Webhook verification ensures the event is authentic before updating our database
      // 4. If the webhook fails, the customer ID won't be saved, maintaining data integrity
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const invoiceId = session.metadata?.invoiceId;
        const stripeCustomerId = session.customer;
        
        console.log(`💳 Processing checkout.session.completed for invoice: ${invoiceId}`);
        console.log(`   Payment status: ${session.payment_status}`);
        
        if (invoiceId) {
          if (session.payment_status === 'paid') {
            let paymentMethodType = 'Credit Card';
            
            if (session.payment_intent) {
              try {
                const stripe = require('stripe')(cachedStripeSecretKey);
                const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent, {
                  expand: ['payment_method']
                });
                if (paymentIntent.payment_method?.type === 'us_bank_account') {
                  paymentMethodType = 'ACH Bank Transfer';
                }
              } catch (err) {
                console.log(`⚠️ Could not determine payment method type, defaulting to Credit Card: ${err.message}`);
              }
            }
            
            console.log(`   Payment method: ${paymentMethodType}`);
            
            const clientId = await stripeService.updateInvoiceAfterPayment(
              invoiceId,
              session,
              paymentMethodType
            );

            if (clientId && stripeCustomerId) {
              try {
                await db.query(
                  'UPDATE clients SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL',
                  [stripeCustomerId, clientId]
                );
                console.log(`✅ Updated client ${clientId} with Stripe customer ID: ${stripeCustomerId}`);
              } catch (err) {
                console.error(`❌ Failed to update client ${clientId} with Stripe customer ID:`, err.message);
              }
            }
          } else if (session.payment_status === 'unpaid' || session.payment_status === 'no_payment_required') {
            console.log(`🏦 Payment pending for invoice ${invoiceId}. Waiting for payment_intent.succeeded.`);
            await stripeService.markInvoicePaymentProcessing(invoiceId);
          }
        }
      } else if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const invoiceId = paymentIntent.metadata?.invoiceId;
        
        if (invoiceId) {
          console.log(`✅ Processing payment_intent.succeeded for invoice: ${invoiceId}`);
          const clientId = await stripeService.updateInvoiceAfterAsyncPayment(invoiceId, paymentIntent);
          
          const stripeCustomerId = paymentIntent.customer;
          if (clientId && stripeCustomerId) {
            try {
              await db.query(
                'UPDATE clients SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL',
                [stripeCustomerId, clientId]
              );
              console.log(`✅ Updated client ${clientId} with Stripe customer ID: ${stripeCustomerId}`);
            } catch (err) {
              console.error(`❌ Failed to update client ${clientId} with Stripe customer ID:`, err.message);
            }
          }
        }
      } else if (event.type === 'payment_intent.processing') {
        const paymentIntent = event.data.object;
        const invoiceId = paymentIntent.metadata?.invoiceId;
        
        if (invoiceId) {
          console.log(`🔄 ACH payment processing for invoice: ${invoiceId}`);
          await stripeService.markInvoicePaymentProcessing(invoiceId);
        }
      } else if (event.type === 'payment_intent.payment_failed') {
        const intent = event.data.object;
        const invoiceId = intent.metadata?.invoiceId;
        if (invoiceId) {
          await db.query(
            `UPDATE invoices SET status = 'Sent', updated_at = NOW() WHERE id = $1 AND status != 'Paid'`,
            [invoiceId]
          );
          console.log(`⚠️ Payment failed for invoice ${invoiceId}. Status reset to Sent.`);
        }
      } else {
        // Log other event types for debugging (but don't error)
        console.log(`ℹ️ Stripe event ${event.type} received but no specific handler implemented`);
      }
      
      res.status(200).json({ received: true });
    } catch (error) {
      // WEBHOOK ERROR HANDLING: Return appropriate HTTP codes for Stripe retry logic
      // 200 = Already processed (idempotent case, don't retry)
      // 400 = Invalid request/signature (don't retry)
      // 500 = Transient error (Stripe should retry)
      
      // Check if this is a signature verification error
      if (error.message && error.message.includes('No signatures found matching the expected signature')) {
        console.error('❌ Webhook signature verification failed:', error.message);
        console.error('   This indicates an invalid webhook signature. Rejecting request.');
        return res.status(400).json({ error: 'Invalid signature' });
      }
      
      // Check if this is an idempotency case (already processed)
      if (error.message && error.message.includes('already recorded')) {
        console.log('✅ Webhook already processed (idempotent). Returning 200.');
        return res.status(200).json({ received: true, note: 'Already processed' });
      }
      
      // Check for validation errors (don't retry)
      if (error.message && (
        error.message.includes('validation failed') ||
        error.message.includes('Invalid currency') ||
        error.message.includes('not found')
      )) {
        console.error('❌ Webhook validation error:', error.message);
        console.error('   This is a permanent error. Stripe should not retry.');
        return res.status(400).json({ error: 'Validation error', details: error.message });
      }
      
      // All other errors are considered transient - return 500 so Stripe retries
      console.error('❌ Webhook processing error (transient):', error.message);
      console.error('   Returning 500 so Stripe will retry this webhook.');
      res.status(500).json({ error: 'Transient processing error' });
    }
  }
);

// Apply shared middleware after the Stripe webhook so express.json() does not
// interfere with express.raw() handling.
applyStandardMiddleware(app);

const apiRouter = express.Router();

const handleError = (res, err) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
};

// ============================================================================
// USER MANAGEMENT ROUTES (Owner-only)
// ============================================================================
apiRouter.get('/users', isAuthenticated, userManagement.listUsers);
apiRouter.get('/users/pending', isAuthenticated, userManagement.getPendingUsers);
apiRouter.get('/users/roles-config', isAuthenticated, userManagement.getRolesAndPermissions);
apiRouter.get('/users/:userId', isAuthenticated, userManagement.getUserDetails);
apiRouter.post('/users/:userId/approve', isAuthenticated, userManagement.approveUser);
apiRouter.post('/users/:userId/reject', isAuthenticated, userManagement.rejectUser);
apiRouter.post('/users/:userId/roles', isAuthenticated, userManagement.assignUserRole);
apiRouter.delete('/users/:userId/roles/:role', isAuthenticated, userManagement.removeUserRole);
apiRouter.put('/users/:userId/permissions', isAuthenticated, userManagement.updateUserCustomPermissions);

const collectionDocIdPrefixes = {
  clients: 'client',
  leads: 'lead',
  quotes: 'quote',
  jobs: 'job',
  employees: 'employee',
  equipment: 'equipment'
};

const reindexDocument = async (tableName, row) => {
  if (!row) return;

  try {
    console.log(`[RAG] Re-indexing document for ${tableName} ID: ${row.id}`);
    switch (tableName) {
      case 'clients':
        await ragService.indexCustomers([row]);
        break;
      case 'leads':
        {
          const { rows: leads } = await db.query(`
            SELECT l.*, 
                   CONCAT(c.first_name, ' ', c.last_name) as customer_name,
                   c.billing_address_line1 as address, 
                   c.primary_phone as phone, 
                   c.primary_email as email
            FROM leads l LEFT JOIN clients c ON l.client_id_new = c.id
            WHERE l.id = $1
          `, [row.id]);
          if (leads.length) {
            await ragService.indexLeads(leads);
          }
        }
        break;
      case 'quotes':
        await ragService.indexQuotes([row]);
        break;
      case 'jobs':
        await ragService.indexJobs([row]);
        break;
      case 'employees':
        await ragService.indexEmployees([row]);
        break;
      case 'equipment':
        await ragService.indexEquipment([row]);
        break;
      default:
        break;
    }
    console.log('[RAG] Re-indexing complete.');
  } catch (err) {
    console.error('[RAG] Failed to re-index document:', err);
  }
};

const removeFromVectorStore = async (tableName, id) => {
  const prefix = collectionDocIdPrefixes[tableName];
  if (!prefix) {
    return;
  }

  try {
    await vectorStore.removeDocument(tableName, `${prefix}_${id}`);
  } catch (err) {
    console.error('[RAG] Error removing document from vector store:', err);
  }
};

const scheduleFinancialReminders = () => {
  const parseDate = (value) => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const run = async () => {
    try {
      await reminderService.hydrateReminderSchedule();
      await reminderService.runDunningCheck();

      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const { rows: quotes } = await db.query("SELECT * FROM quotes WHERE status = 'Sent'");
      quotes.forEach(quote => {
        const createdAt = parseDate(quote.created_at);
        if (!createdAt) return;

        const ageDays = Math.floor((startOfToday.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
        if (ageDays >= 14) {
          console.log(`📧 [Quote Follow-up] Quote ${quote.id} for ${quote.customer_name} has been open for ${ageDays} days. Consider a polite follow-up.`);
        }
      });
    } catch (error) {
      console.error('⚠️ Automated reminder check failed:', error.message);
      console.error('   The reminder job will continue and retry on the next interval.');
    }
  };

  run();
  reminderInterval = setInterval(run, reminderService.ONE_DAY_MS);
};

// Helper function to transform database row to API format
const transformRow = (row, tableName) => {
  if (!row) return null;
  
  const transformed = { ...row };
  
  // Handle coordinate fields
  if (tableName === 'clients' || tableName === 'employees') {
    if (row.lat !== undefined && row.lon !== undefined) {
      transformed.coordinates = { lat: row.lat, lng: row.lon };
      delete transformed.lat;
      delete transformed.lon;
    }
  }
  
  // Transform employees fields
  if (tableName === 'employees') {
    if (row.job_title !== undefined) {
      transformed.jobTitle = row.job_title;
      delete transformed.job_title;
    }
    if (row.pay_rate !== undefined) {
      transformed.payRate = (row.pay_rate !== null && row.pay_rate !== '') ? parseFloat(row.pay_rate) : row.pay_rate;
      delete transformed.pay_rate;
    }
    if (row.hire_date !== undefined) {
      transformed.hireDate = row.hire_date;
      delete transformed.hire_date;
    }
    if (row.performance_metrics !== undefined) {
      transformed.performanceMetrics = row.performance_metrics;
      delete transformed.performance_metrics;
    }
  }
  
  // Transform equipment fields
  if (tableName === 'equipment') {
    if (row.purchase_date !== undefined) {
      transformed.purchaseDate = row.purchase_date;
      delete transformed.purchase_date;
    }
    if (row.last_service_date !== undefined) {
      transformed.lastServiceDate = row.last_service_date;
      delete transformed.last_service_date;
    }
    if (row.assigned_to !== undefined) {
      transformed.assignedTo = row.assigned_to;
      delete transformed.assigned_to;
    }
    if (row.maintenance_history !== undefined) {
      transformed.maintenanceHistory = row.maintenance_history;
      delete transformed.maintenance_history;
    }
  }
  
  // Transform quotes fields
  if (tableName === 'quotes') {
    if (row.lead_id !== undefined) {
      transformed.leadId = row.lead_id;
      delete transformed.lead_id;
    }
    if (row.client_id !== undefined) {
      transformed.clientId = row.client_id;
      delete transformed.client_id;
    }
    if (row.property_id !== undefined) {
      transformed.propertyId = row.property_id;
      delete transformed.property_id;
    }
    if (row.quote_number !== undefined) {
      transformed.quoteNumber = row.quote_number;
      delete transformed.quote_number;
    }
    if (row.approval_status !== undefined) {
      transformed.approvalStatus = row.approval_status;
      delete transformed.approval_status;
    }
    if (row.approved_by !== undefined) {
      transformed.approvedBy = row.approved_by;
      delete transformed.approved_by;
    }
    if (row.approved_at !== undefined) {
      transformed.approvedAt = row.approved_at;
      delete transformed.approved_at;
    }
    if (row.terms_and_conditions !== undefined) {
      transformed.termsAndConditions = row.terms_and_conditions;
      delete transformed.terms_and_conditions;
    }
    if (row.internal_notes !== undefined) {
      transformed.internalNotes = row.internal_notes;
      delete transformed.internal_notes;
    }
    if (row.total_amount !== undefined) {
      transformed.totalAmount = (row.total_amount !== null && row.total_amount !== '') ? parseFloat(row.total_amount) : row.total_amount;
      delete transformed.total_amount;
    }
    if (row.discount_amount !== undefined) {
      transformed.discountAmount = (row.discount_amount !== null && row.discount_amount !== '') ? parseFloat(row.discount_amount) : row.discount_amount;
      delete transformed.discount_amount;
    }
    if (row.discount_percentage !== undefined) {
      transformed.discountPercentage = (row.discount_percentage !== null && row.discount_percentage !== '') ? parseFloat(row.discount_percentage) : row.discount_percentage;
      delete transformed.discount_percentage;
    }
    if (row.tax_rate !== undefined) {
      transformed.taxRate = (row.tax_rate !== null && row.tax_rate !== '') ? parseFloat(row.tax_rate) : row.tax_rate;
      delete transformed.tax_rate;
    }
    if (row.tax_amount !== undefined) {
      transformed.taxAmount = (row.tax_amount !== null && row.tax_amount !== '') ? parseFloat(row.tax_amount) : row.tax_amount;
      delete transformed.tax_amount;
    }
    if (row.grand_total !== undefined) {
      transformed.grandTotal = (row.grand_total !== null && row.grand_total !== '') ? parseFloat(row.grand_total) : row.grand_total;
      delete transformed.grand_total;
    }
    if (row.updated_at !== undefined) {
      transformed.updatedAt = row.updated_at;
      delete transformed.updated_at;
    }
    if (row.deleted_at !== undefined) {
      transformed.deletedAt = row.deleted_at;
      delete transformed.deleted_at;
    }
    if (row.customer_name !== undefined) {
      transformed.customerName = row.customer_name;
      delete transformed.customer_name;
    }
    if (row.line_items !== undefined) {
      transformed.lineItems = row.line_items;
      delete transformed.line_items;
    }
    if (row.stump_grinding_price !== undefined) {
      transformed.stumpGrindingPrice = (row.stump_grinding_price !== null && row.stump_grinding_price !== '') ? parseFloat(row.stump_grinding_price) : row.stump_grinding_price;
      delete transformed.stump_grinding_price;
    }
    if (row.accepted_at !== undefined) {
      transformed.acceptedAt = row.accepted_at;
      delete transformed.accepted_at;
    }
    if (row.job_location !== undefined) {
      transformed.jobLocation = row.job_location;
      delete transformed.job_location;
    }
    if (row.special_instructions !== undefined) {
      transformed.specialInstructions = row.special_instructions;
      delete transformed.special_instructions;
    }
    if (row.valid_until !== undefined) {
      transformed.validUntil = row.valid_until;
      delete transformed.valid_until;
    }
    if (row.deposit_amount !== undefined) {
      transformed.depositAmount = (row.deposit_amount !== null && row.deposit_amount !== '') ? parseFloat(row.deposit_amount) : row.deposit_amount;
      delete transformed.deposit_amount;
    }
    if (row.payment_terms !== undefined) {
      transformed.paymentTerms = row.payment_terms;
      delete transformed.payment_terms;
    }
    if (row.customer_uploads !== undefined) {
      transformed.customerUploads = row.customer_uploads;
      delete transformed.customer_uploads;
    }
  }

  // Transform leads fields
  if (tableName === 'leads') {
    if (row.customer_id !== undefined) {
      transformed.customerId = row.customer_id;
      delete transformed.customer_id;
    }
    if (row.customer_uploads !== undefined) {
      transformed.customerUploads = row.customer_uploads;
      delete transformed.customer_uploads;
    }
  }

  if (tableName === 'jobs') {
    if (row.clock_in_lat !== undefined && row.clock_in_lon !== undefined) {
      transformed.clockInCoordinates = { lat: row.clock_in_lat, lng: row.clock_in_lon };
      delete transformed.clock_in_lat;
      delete transformed.clock_in_lon;
    }
    if (row.clock_out_lat !== undefined && row.clock_out_lon !== undefined) {
      transformed.clockOutCoordinates = { lat: row.clock_out_lat, lng: row.clock_out_lon };
      delete transformed.clock_out_lat;
      delete transformed.clock_out_lon;
    }
    // Transform snake_case to camelCase for job fields
    if (row.work_started_at !== undefined) {
      transformed.workStartedAt = row.work_started_at;
      delete transformed.work_started_at;
    }
    if (row.work_ended_at !== undefined) {
      transformed.workEndedAt = row.work_ended_at;
      delete transformed.work_ended_at;
    }
    if (row.assigned_crew !== undefined) {
      transformed.assignedCrew = row.assigned_crew;
      delete transformed.assigned_crew;
    }
    if (row.stump_grinding_price !== undefined) {
      transformed.stumpGrindingPrice = (row.stump_grinding_price !== null && row.stump_grinding_price !== '') ? parseFloat(row.stump_grinding_price) : row.stump_grinding_price;
      delete transformed.stump_grinding_price;
    }
    if (row.quote_id !== undefined) {
      transformed.quoteId = row.quote_id;
      delete transformed.quote_id;
    }
    if (row.customer_name !== undefined) {
      transformed.customerName = row.customer_name;
      delete transformed.customer_name;
    }
    if (row.scheduled_date !== undefined) {
      transformed.scheduledDate = row.scheduled_date;
      delete transformed.scheduled_date;
    }
    if (row.job_location !== undefined) {
      transformed.jobLocation = row.job_location;
      delete transformed.job_location;
    }
    if (row.special_instructions !== undefined) {
      transformed.specialInstructions = row.special_instructions;
      delete transformed.special_instructions;
    }
    if (row.required_crew_size !== undefined) {
      transformed.requiredCrewSize = row.required_crew_size !== null ? Number(row.required_crew_size) : null;
      delete transformed.required_crew_size;
    }
    if (row.job_template_id !== undefined) {
      transformed.jobTemplateId = row.job_template_id;
      delete transformed.job_template_id;
    }
    if (row.equipment_needed !== undefined) {
      transformed.equipmentNeeded = row.equipment_needed;
      delete transformed.equipment_needed;
    }
    if (row.estimated_hours !== undefined) {
      transformed.estimatedHours = (row.estimated_hours !== null && row.estimated_hours !== '') ? parseFloat(row.estimated_hours) : row.estimated_hours;
      delete transformed.estimated_hours;
    }
    if (row.jha_acknowledged_at !== undefined) {
      transformed.jhaAcknowledgedAt = row.jha_acknowledged_at;
      delete transformed.jha_acknowledged_at;
    }
    if (row.risk_level !== undefined) {
      transformed.riskLevel = row.risk_level;
      delete transformed.risk_level;
    }
    if (row.jha_required !== undefined) {
      transformed.jhaRequired = row.jha_required;
      delete transformed.jha_required;
    }
    if (row.quote_version !== undefined) {
      transformed.quoteVersion = row.quote_version;
      delete transformed.quote_version;
    }
    if (row.quote_approval_status !== undefined) {
      transformed.quoteApprovalStatus = row.quote_approval_status;
      delete transformed.quote_approval_status;
    }
    if (row.quote_approved_by !== undefined) {
      transformed.quoteApprovedBy = row.quote_approved_by;
      delete transformed.quote_approved_by;
    }
    if (row.quote_approved_at !== undefined) {
      transformed.quoteApprovedAt = row.quote_approved_at;
      delete transformed.quote_approved_at;
    }
    if (row.quote_number !== undefined) {
      transformed.quoteNumber = row.quote_number;
      delete transformed.quote_number;
    }
  }

  if (tableName === 'job_series') {
    if (row.client_id !== undefined) {
      transformed.clientId = row.client_id;
      delete transformed.client_id;
    }
    if (row.property_id !== undefined) {
      transformed.propertyId = row.property_id;
      delete transformed.property_id;
    }
    if (row.series_name !== undefined) {
      transformed.seriesName = row.series_name;
      delete transformed.series_name;
    }
    if (row.service_type !== undefined) {
      transformed.serviceType = row.service_type;
      delete transformed.service_type;
    }
    if (row.recurrence_pattern !== undefined) {
      transformed.recurrencePattern = row.recurrence_pattern;
      delete transformed.recurrence_pattern;
    }
    if (row.recurrence_interval !== undefined) {
      transformed.recurrenceInterval = Number(row.recurrence_interval);
      delete transformed.recurrence_interval;
    }
    if (row.recurrence_day_of_week !== undefined) {
      transformed.recurrenceDayOfWeek = row.recurrence_day_of_week;
      delete transformed.recurrence_day_of_week;
    }
    if (row.recurrence_day_of_month !== undefined) {
      transformed.recurrenceDayOfMonth = row.recurrence_day_of_month;
      delete transformed.recurrence_day_of_month;
    }
    if (row.recurrence_month !== undefined) {
      transformed.recurrenceMonth = row.recurrence_month;
      delete transformed.recurrence_month;
    }
    if (row.start_date !== undefined) {
      transformed.startDate = row.start_date;
      delete transformed.start_date;
    }
    if (row.end_date !== undefined) {
      transformed.endDate = row.end_date;
      delete transformed.end_date;
    }
    if (row.is_active !== undefined) {
      transformed.isActive = row.is_active;
      delete transformed.is_active;
    }
    if (row.job_template_id !== undefined) {
      transformed.jobTemplateId = row.job_template_id;
      delete transformed.job_template_id;
    }
    if (row.default_crew_id !== undefined) {
      transformed.defaultCrewId = row.default_crew_id;
      delete transformed.default_crew_id;
    }
    if (row.estimated_duration_hours !== undefined) {
      transformed.estimatedDurationHours = row.estimated_duration_hours !== null ? Number(row.estimated_duration_hours) : null;
      delete transformed.estimated_duration_hours;
    }
  }

  if (tableName === 'recurring_job_instances') {
    if (row.job_series_id !== undefined) {
      transformed.jobSeriesId = row.job_series_id;
      delete transformed.job_series_id;
    }
    if (row.job_id !== undefined) {
      transformed.jobId = row.job_id;
      delete transformed.job_id;
    }
    if (row.scheduled_date !== undefined) {
      transformed.scheduledDate = row.scheduled_date;
      delete transformed.scheduled_date;
    }
  }

  // Transform pay_periods fields
  if (tableName === 'pay_periods') {
    if (row.start_date !== undefined) {
      transformed.startDate = row.start_date;
      delete transformed.start_date;
    }
    if (row.end_date !== undefined) {
      transformed.endDate = row.end_date;
      delete transformed.end_date;
    }
    if (row.period_type !== undefined) {
      transformed.periodType = row.period_type;
      delete transformed.period_type;
    }
    if (row.processed_at !== undefined) {
      transformed.processedAt = row.processed_at;
      delete transformed.processed_at;
    }
  }
  
  // Transform time_entries fields
  if (tableName === 'time_entries') {
    if (row.employee_id !== undefined) {
      transformed.employeeId = row.employee_id;
      delete transformed.employee_id;
    }
    if (row.job_id !== undefined) {
      transformed.jobId = row.job_id;
      delete transformed.job_id;
    }
    if (row.hours_worked !== undefined) {
      transformed.hoursWorked = (row.hours_worked !== null && row.hours_worked !== '') ? parseFloat(row.hours_worked) : row.hours_worked;
      delete transformed.hours_worked;
    }
    if (row.hourly_rate !== undefined) {
      transformed.hourlyRate = (row.hourly_rate !== null && row.hourly_rate !== '') ? parseFloat(row.hourly_rate) : row.hourly_rate;
      delete transformed.hourly_rate;
    }
    if (row.overtime_hours !== undefined) {
      transformed.overtimeHours = (row.overtime_hours !== null && row.overtime_hours !== '') ? parseFloat(row.overtime_hours) : row.overtime_hours;
      delete transformed.overtime_hours;
    }
  }
  
  // Transform payroll_records fields
  if (tableName === 'payroll_records') {
    if (row.employee_id !== undefined) {
      transformed.employeeId = row.employee_id;
      delete transformed.employee_id;
    }
    if (row.pay_period_id !== undefined) {
      transformed.payPeriodId = row.pay_period_id;
      delete transformed.pay_period_id;
    }
    if (row.regular_hours !== undefined) {
      transformed.regularHours = (row.regular_hours !== null && row.regular_hours !== '') ? parseFloat(row.regular_hours) : row.regular_hours;
      delete transformed.regular_hours;
    }
    if (row.overtime_hours !== undefined) {
      transformed.overtimeHours = (row.overtime_hours !== null && row.overtime_hours !== '') ? parseFloat(row.overtime_hours) : row.overtime_hours;
      delete transformed.overtime_hours;
    }
    if (row.hourly_rate !== undefined) {
      transformed.hourlyRate = (row.hourly_rate !== null && row.hourly_rate !== '') ? parseFloat(row.hourly_rate) : row.hourly_rate;
      delete transformed.hourly_rate;
    }
    if (row.regular_pay !== undefined) {
      transformed.regularPay = (row.regular_pay !== null && row.regular_pay !== '') ? parseFloat(row.regular_pay) : row.regular_pay;
      delete transformed.regular_pay;
    }
    if (row.overtime_pay !== undefined) {
      transformed.overtimePay = (row.overtime_pay !== null && row.overtime_pay !== '') ? parseFloat(row.overtime_pay) : row.overtime_pay;
      delete transformed.overtime_pay;
    }
    if (row.total_deductions !== undefined) {
      transformed.totalDeductions = (row.total_deductions !== null && row.total_deductions !== '') ? parseFloat(row.total_deductions) : row.total_deductions;
      delete transformed.total_deductions;
    }
    if (row.gross_pay !== undefined) {
      transformed.grossPay = (row.gross_pay !== null && row.gross_pay !== '') ? parseFloat(row.gross_pay) : row.gross_pay;
      delete transformed.gross_pay;
    }
    if (row.net_pay !== undefined) {
      transformed.netPay = (row.net_pay !== null && row.net_pay !== '') ? parseFloat(row.net_pay) : row.net_pay;
      delete transformed.net_pay;
    }
    if (row.paid_at !== undefined) {
      transformed.paidAt = row.paid_at;
      delete transformed.paid_at;
    }
    if (row.payment_method !== undefined) {
      transformed.paymentMethod = row.payment_method;
      delete transformed.payment_method;
    }
  }
  
  // Transform company_profile fields
  if (tableName === 'company_profile') {
    if (row.company_name !== undefined) {
      transformed.companyName = row.company_name;
      delete transformed.company_name;
    }
    if (row.phone_number !== undefined) {
      transformed.phoneNumber = row.phone_number;
      delete transformed.phone_number;
    }
    if (row.tax_ein !== undefined) {
      transformed.taxEin = row.tax_ein;
      delete transformed.tax_ein;
    }
    if (row.zip_code !== undefined) {
      transformed.zipCode = row.zip_code;
      delete transformed.zip_code;
    }
    if (row.logo_url !== undefined) {
      transformed.logoUrl = row.logo_url;
      delete transformed.logo_url;
    }
    if (row.business_hours !== undefined) {
      transformed.businessHours = row.business_hours;
      delete transformed.business_hours;
    }
    if (row.license_number !== undefined) {
      transformed.licenseNumber = row.license_number;
      delete transformed.license_number;
    }
    if (row.insurance_policy_number !== undefined) {
      transformed.insurancePolicyNumber = row.insurance_policy_number;
      delete transformed.insurance_policy_number;
    }
    if (row.updated_at !== undefined) {
      transformed.updatedAt = row.updated_at;
      delete transformed.updated_at;
    }
    if (row.created_at !== undefined) {
      transformed.createdAt = row.created_at;
      delete transformed.created_at;
    }
  }
  
  // Transform estimate_feedback fields
  if (tableName === 'estimate_feedback') {
    if (row.quote_id !== undefined) {
      transformed.quoteId = row.quote_id;
      delete transformed.quote_id;
    }
    if (row.ai_estimate_data !== undefined) {
      transformed.aiEstimateData = row.ai_estimate_data;
      delete transformed.ai_estimate_data;
    }
    if (row.ai_suggested_price_min !== undefined) {
      transformed.aiSuggestedPriceMin = (row.ai_suggested_price_min !== null && row.ai_suggested_price_min !== '') ? parseFloat(row.ai_suggested_price_min) : row.ai_suggested_price_min;
      delete transformed.ai_suggested_price_min;
    }
    if (row.ai_suggested_price_max !== undefined) {
      transformed.aiSuggestedPriceMax = (row.ai_suggested_price_max !== null && row.ai_suggested_price_max !== '') ? parseFloat(row.ai_suggested_price_max) : row.ai_suggested_price_max;
      delete transformed.ai_suggested_price_max;
    }
    if (row.actual_price_quoted !== undefined) {
      transformed.actualPriceQuoted = (row.actual_price_quoted !== null && row.actual_price_quoted !== '') ? parseFloat(row.actual_price_quoted) : row.actual_price_quoted;
      delete transformed.actual_price_quoted;
    }
    if (row.feedback_rating !== undefined) {
      transformed.feedbackRating = row.feedback_rating;
      delete transformed.feedback_rating;
    }
    if (row.correction_reasons !== undefined) {
      transformed.correctionReasons = row.correction_reasons;
      delete transformed.correction_reasons;
    }
    if (row.user_notes !== undefined) {
      transformed.userNotes = row.user_notes;
      delete transformed.user_notes;
    }
    if (row.tree_species !== undefined) {
      transformed.treeSpecies = row.tree_species;
      delete transformed.tree_species;
    }
    if (row.tree_height !== undefined) {
      transformed.treeHeight = (row.tree_height !== null && row.tree_height !== '') ? parseFloat(row.tree_height) : row.tree_height;
      delete transformed.tree_height;
    }
    if (row.trunk_diameter !== undefined) {
      transformed.trunkDiameter = (row.trunk_diameter !== null && row.trunk_diameter !== '') ? parseFloat(row.trunk_diameter) : row.trunk_diameter;
      delete transformed.trunk_diameter;
    }
    if (row.job_location !== undefined) {
      transformed.jobLocation = row.job_location;
      delete transformed.job_location;
    }
    if (row.customer_name !== undefined) {
      transformed.customerName = row.customer_name;
      delete transformed.customer_name;
    }
  }
  
  // Transform crews fields
  if (tableName === 'crews') {
    if (row.is_active !== undefined) {
      transformed.isActive = row.is_active;
      delete transformed.is_active;
    }
    if (row.default_start_time !== undefined) {
      transformed.defaultStartTime = row.default_start_time;
      delete transformed.default_start_time;
    }
    if (row.default_end_time !== undefined) {
      transformed.defaultEndTime = row.default_end_time;
      delete transformed.default_end_time;
    }
    if (row.updated_at !== undefined) {
      transformed.updatedAt = row.updated_at;
      delete transformed.updated_at;
    }
    if (row.deleted_at !== undefined) {
      transformed.deletedAt = row.deleted_at;
      delete transformed.deleted_at;
    }
    if (row.member_count !== undefined) {
      transformed.memberCount = parseInt(row.member_count) || 0;
      delete transformed.member_count;
    }
  }
  
  // Transform crew_members fields
  if (tableName === 'crew_members') {
    if (row.crew_id !== undefined) {
      transformed.crewId = row.crew_id;
      delete transformed.crew_id;
    }
    if (row.employee_id !== undefined) {
      transformed.employeeId = row.employee_id;
      delete transformed.employee_id;
    }
    if (row.joined_at !== undefined) {
      transformed.joinedAt = row.joined_at;
      delete transformed.joined_at;
    }
    if (row.left_at !== undefined) {
      transformed.leftAt = row.left_at;
      delete transformed.left_at;
    }
    if (row.employee_name !== undefined) {
      transformed.employeeName = row.employee_name;
      delete transformed.employee_name;
    }
    if (row.job_title !== undefined) {
      transformed.jobTitle = row.job_title;
      delete transformed.job_title;
    }
  }
  
  // Transform crew_assignments fields
  if (tableName === 'crew_assignments') {
    if (row.job_id !== undefined) {
      transformed.jobId = row.job_id;
      delete transformed.job_id;
    }
    if (row.crew_id !== undefined) {
      transformed.crewId = row.crew_id;
      delete transformed.crew_id;
    }
    if (row.assigned_date !== undefined) {
      transformed.assignedDate = row.assigned_date;
      delete transformed.assigned_date;
    }
    if (row.assigned_by !== undefined) {
      transformed.assignedBy = row.assigned_by;
      delete transformed.assigned_by;
    }
    if (row.created_at !== undefined) {
      transformed.createdAt = row.created_at;
      delete transformed.created_at;
    }
    if (row.crew_name !== undefined) {
      transformed.crewName = row.crew_name;
      delete transformed.crew_name;
    }
    if (row.job_title !== undefined) {
      transformed.jobTitle = row.job_title;
      delete transformed.job_title;
    }
    if (row.customer_name !== undefined) {
      transformed.customerName = row.customer_name;
      delete transformed.customer_name;
    }
    if (row.scheduled_date !== undefined) {
      transformed.scheduledDate = row.scheduled_date;
      delete transformed.scheduled_date;
    }
  }
  
  // Transform form_templates fields
  if (tableName === 'form_templates') {
    if (row.form_type !== undefined) {
      transformed.formType = row.form_type;
      transformed.category = row.form_type;
      delete transformed.form_type;
    }
    if (row.is_active !== undefined) {
      transformed.isActive = row.is_active;
      delete transformed.is_active;
    }
    if (row.require_signature !== undefined) {
      transformed.requireSignature = row.require_signature;
      delete transformed.require_signature;
    }
    if (row.require_photos !== undefined) {
      transformed.requirePhotos = row.require_photos;
      delete transformed.require_photos;
    }
    if (row.min_photos !== undefined) {
      transformed.minPhotos = row.min_photos;
      delete transformed.min_photos;
    }
    if (row.created_by !== undefined) {
      transformed.createdBy = row.created_by;
      delete transformed.created_by;
    }
    if (row.updated_at !== undefined) {
      transformed.updatedAt = row.updated_at;
      delete transformed.updated_at;
    }
    if (row.deleted_at !== undefined) {
      transformed.deletedAt = row.deleted_at;
      delete transformed.deleted_at;
    }
  }
  
  // Transform job_forms fields
  if (tableName === 'job_forms') {
    if (row.job_id !== undefined) {
      transformed.jobId = row.job_id;
      delete transformed.job_id;
    }
    if (row.form_template_id !== undefined) {
      transformed.formTemplateId = row.form_template_id;
      delete transformed.form_template_id;
    }
    if (row.form_data !== undefined) {
      transformed.formData = row.form_data;
      delete transformed.form_data;
    }
    if (row.completed_at !== undefined) {
      transformed.completedAt = row.completed_at;
      delete transformed.completed_at;
    }
    if (row.completed_by !== undefined) {
      transformed.completedBy = row.completed_by;
      delete transformed.completed_by;
    }
    if (row.updated_at !== undefined) {
      transformed.updatedAt = row.updated_at;
      delete transformed.updated_at;
    }
  }
  
  // Transform invoices fields
  if (tableName === 'invoices') {
    if (row.job_id !== undefined) {
      transformed.jobId = row.job_id;
      delete transformed.job_id;
    }
    if (row.quote_id !== undefined) {
      transformed.quoteId = row.quote_id;
      delete transformed.quote_id;
    }
    if (row.client_id !== undefined) {
      transformed.clientId = row.client_id;
      delete transformed.client_id;
    }
    if (row.property_id !== undefined) {
      transformed.propertyId = row.property_id;
      delete transformed.property_id;
    }
    if (row.customer_name !== undefined) {
      transformed.customerName = row.customer_name;
      delete transformed.customer_name;
    }
    if (row.invoice_number !== undefined) {
      transformed.invoiceNumber = row.invoice_number;
      delete transformed.invoice_number;
    }
    if (row.issue_date !== undefined) {
      transformed.issueDate = row.issue_date;
      delete transformed.issue_date;
    }
    if (row.sent_date !== undefined) {
      transformed.sentDate = row.sent_date;
      delete transformed.sent_date;
    }
    if (row.due_date !== undefined) {
      transformed.dueDate = row.due_date;
      delete transformed.due_date;
    }
    if (row.paid_at !== undefined) {
      transformed.paidAt = row.paid_at;
      delete transformed.paid_at;
    }
    if (row.line_items !== undefined) {
      transformed.lineItems = row.line_items;
      delete transformed.line_items;
    }
    if (row.subtotal !== undefined) {
      transformed.subtotal = (row.subtotal !== null && row.subtotal !== '') ? parseFloat(row.subtotal) : row.subtotal;
      delete transformed.subtotal;
    }
    if (row.discount_amount !== undefined) {
      transformed.discountAmount = (row.discount_amount !== null && row.discount_amount !== '') ? parseFloat(row.discount_amount) : row.discount_amount;
      delete transformed.discount_amount;
    }
    if (row.discount_percentage !== undefined) {
      transformed.discountPercentage = (row.discount_percentage !== null && row.discount_percentage !== '') ? parseFloat(row.discount_percentage) : row.discount_percentage;
      delete transformed.discount_percentage;
    }
    if (row.tax_rate !== undefined) {
      transformed.taxRate = (row.tax_rate !== null && row.tax_rate !== '') ? parseFloat(row.tax_rate) : row.tax_rate;
      delete transformed.tax_rate;
    }
    if (row.tax_amount !== undefined) {
      transformed.taxAmount = (row.tax_amount !== null && row.tax_amount !== '') ? parseFloat(row.tax_amount) : row.tax_amount;
      delete transformed.tax_amount;
    }
    if (row.total_amount !== undefined) {
      transformed.totalAmount = (row.total_amount !== null && row.total_amount !== '') ? parseFloat(row.total_amount) : row.total_amount;
      delete transformed.total_amount;
    }
    if (row.grand_total !== undefined) {
      transformed.grandTotal = (row.grand_total !== null && row.grand_total !== '') ? parseFloat(row.grand_total) : row.grand_total;
      delete transformed.grand_total;
    }
    if (row.amount_paid !== undefined) {
      transformed.amountPaid = (row.amount_paid !== null && row.amount_paid !== '') ? parseFloat(row.amount_paid) : row.amount_paid;
      delete transformed.amount_paid;
    }
    if (row.amount_due !== undefined) {
      transformed.amountDue = (row.amount_due !== null && row.amount_due !== '') ? parseFloat(row.amount_due) : row.amount_due;
      delete transformed.amount_due;
    }
    if (row.payment_terms !== undefined) {
      transformed.paymentTerms = row.payment_terms;
      delete transformed.payment_terms;
    }
    if (row.customer_email !== undefined) {
      transformed.customerEmail = row.customer_email;
      delete transformed.customer_email;
    }
    if (row.customer_phone !== undefined) {
      transformed.customerPhone = row.customer_phone;
      delete transformed.customer_phone;
    }
    if (row.customer_address !== undefined) {
      transformed.customerAddress = row.customer_address;
      delete transformed.customer_address;
    }
    if (row.customer_notes !== undefined) {
      transformed.customerNotes = row.customer_notes;
      delete transformed.customer_notes;
    }
    if (row.updated_at !== undefined) {
      transformed.updatedAt = row.updated_at;
      delete transformed.updated_at;
    }
  }
  
  // Transform payment_records fields
  if (tableName === 'payment_records') {
    if (row.invoice_id !== undefined) {
      transformed.invoiceId = row.invoice_id;
      delete transformed.invoice_id;
    }
    if (row.payment_date !== undefined) {
      transformed.paymentDate = row.payment_date;
      delete transformed.payment_date;
    }
    if (row.payment_method !== undefined) {
      transformed.paymentMethod = row.payment_method;
      delete transformed.payment_method;
    }
    if (row.transaction_id !== undefined) {
      transformed.transactionId = row.transaction_id;
      delete transformed.transaction_id;
    }
    if (row.reference_number !== undefined) {
      transformed.referenceNumber = row.reference_number;
      delete transformed.reference_number;
    }
    if (row.recorded_by !== undefined) {
      transformed.recordedBy = row.recorded_by;
      delete transformed.recorded_by;
    }
    if (row.created_at !== undefined) {
      transformed.createdAt = row.created_at;
      delete transformed.created_at;
    }
  }
  
  // Transform other snake_case fields
  if (row.created_at !== undefined) {
    transformed.createdAt = row.created_at;
    delete transformed.created_at;
  }
  
  return transformed;
};

// Helper function to transform API data to database format
const transformToDb = (data, tableName) => {
  const transformed = { ...data };
  
  // Handle coordinate fields
  if ((tableName === 'clients' || tableName === 'employees') && data.coordinates) {
    transformed.lat = data.coordinates.lat;
    transformed.lon = data.coordinates.lng;
    delete transformed.coordinates;
  }
  
  // Transform employees fields
  if (tableName === 'employees') {
    if (data.jobTitle !== undefined) {
      transformed.job_title = data.jobTitle;
      delete transformed.jobTitle;
    }
    if (data.payRate !== undefined) {
      transformed.pay_rate = data.payRate;
      delete transformed.payRate;
    }
    if (data.hireDate !== undefined) {
      transformed.hire_date = data.hireDate;
      delete transformed.hireDate;
    }
    if (data.performanceMetrics !== undefined) {
      transformed.performance_metrics = data.performanceMetrics;
      delete transformed.performanceMetrics;
    }
  }
  
  // Transform equipment fields
  if (tableName === 'equipment') {
    if (data.purchaseDate !== undefined) {
      transformed.purchase_date = data.purchaseDate;
      delete transformed.purchaseDate;
    }
    if (data.lastServiceDate !== undefined) {
      transformed.last_service_date = data.lastServiceDate;
      delete transformed.lastServiceDate;
    }
    if (data.assignedTo !== undefined) {
      transformed.assigned_to = data.assignedTo;
      delete transformed.assignedTo;
    }
    if (data.maintenanceHistory !== undefined) {
      transformed.maintenance_history = data.maintenanceHistory;
      delete transformed.maintenanceHistory;
    }
  }
  
  // Transform quotes fields
  if (tableName === 'quotes') {
    if (data.leadId !== undefined) {
      transformed.lead_id = data.leadId;
      delete transformed.leadId;
    }
    if (data.clientId !== undefined) {
      transformed.client_id = data.clientId;
      delete transformed.clientId;
    }
    if (data.propertyId !== undefined) {
      transformed.property_id = data.propertyId;
      delete transformed.propertyId;
    }
    if (data.quoteNumber !== undefined) {
      transformed.quote_number = data.quoteNumber;
      delete transformed.quoteNumber;
    }
    if (data.approvalStatus !== undefined) {
      transformed.approval_status = data.approvalStatus;
      delete transformed.approvalStatus;
    }
    if (data.approvedBy !== undefined) {
      transformed.approved_by = data.approvedBy;
      delete transformed.approvedBy;
    }
    if (data.approvedAt !== undefined) {
      transformed.approved_at = data.approvedAt;
      delete transformed.approvedAt;
    }
    if (data.termsAndConditions !== undefined) {
      transformed.terms_and_conditions = data.termsAndConditions;
      delete transformed.termsAndConditions;
    }
    if (data.internalNotes !== undefined) {
      transformed.internal_notes = data.internalNotes;
      delete transformed.internalNotes;
    }
    if (data.totalAmount !== undefined) {
      transformed.total_amount = data.totalAmount;
      delete transformed.totalAmount;
    }
    if (data.discountAmount !== undefined) {
      transformed.discount_amount = data.discountAmount;
      delete transformed.discountAmount;
    }
    if (data.discountPercentage !== undefined) {
      transformed.discount_percentage = data.discountPercentage;
      delete transformed.discountPercentage;
    }
    if (data.taxRate !== undefined) {
      transformed.tax_rate = data.taxRate;
      delete transformed.taxRate;
    }
    if (data.taxAmount !== undefined) {
      transformed.tax_amount = data.taxAmount;
      delete transformed.taxAmount;
    }
    if (data.grandTotal !== undefined) {
      transformed.grand_total = data.grandTotal;
      delete transformed.grandTotal;
    }
    if (data.updatedAt !== undefined) {
      transformed.updated_at = data.updatedAt;
      delete transformed.updatedAt;
    }
    if (data.deletedAt !== undefined) {
      transformed.deleted_at = data.deletedAt;
      delete transformed.deletedAt;
    }
    if (data.customerName !== undefined) {
      transformed.customer_name = data.customerName;
      delete transformed.customerName;
    }
    if (data.lineItems !== undefined) {
      transformed.line_items = data.lineItems;
      delete transformed.lineItems;
    }
    if (data.stumpGrindingPrice !== undefined) {
      transformed.stump_grinding_price = data.stumpGrindingPrice;
      delete transformed.stumpGrindingPrice;
    }
    if (data.acceptedAt !== undefined) {
      transformed.accepted_at = data.acceptedAt;
      delete transformed.acceptedAt;
    }
    if (data.jobLocation !== undefined) {
      transformed.job_location = data.jobLocation;
      delete transformed.jobLocation;
    }
    if (data.specialInstructions !== undefined) {
      transformed.special_instructions = data.specialInstructions;
      delete transformed.specialInstructions;
    }
    if (data.validUntil !== undefined) {
      transformed.valid_until = data.validUntil;
      delete transformed.validUntil;
    }
    if (data.depositAmount !== undefined) {
      transformed.deposit_amount = data.depositAmount;
      delete transformed.depositAmount;
    }
    if (data.paymentTerms !== undefined) {
      transformed.payment_terms = data.paymentTerms;
      delete transformed.paymentTerms;
    }
    if (data.customerUploads !== undefined) {
      transformed.customer_uploads = data.customerUploads;
      delete transformed.customerUploads;
    }
  }

  // Transform leads fields
  if (tableName === 'leads') {
    if (data.customerId !== undefined) {
      transformed.customer_id = data.customerId;
      delete transformed.customerId;
    }
    if (data.customerUploads !== undefined) {
      transformed.customer_uploads = data.customerUploads;
      delete transformed.customerUploads;
    }
  }

  if (tableName === 'jobs') {
    // Ensure status defaults to 'draft' if not provided (valid per job state machine)
    if (!transformed.status || transformed.status === '' || transformed.status === 'Unscheduled') {
      transformed.status = 'draft';
    }
    
    if (data.clockInCoordinates) {
      transformed.clock_in_lat = data.clockInCoordinates.lat;
      transformed.clock_in_lon = data.clockInCoordinates.lng;
      delete transformed.clockInCoordinates;
    }
    if (data.clockOutCoordinates) {
      transformed.clock_out_lat = data.clockOutCoordinates.lat;
      transformed.clock_out_lon = data.clockOutCoordinates.lng;
      delete transformed.clockOutCoordinates;
    }
    // Transform camelCase to snake_case
    if (data.workStartedAt !== undefined) {
      transformed.work_started_at = data.workStartedAt;
      delete transformed.workStartedAt;
    }
    if (data.workEndedAt !== undefined) {
      transformed.work_ended_at = data.workEndedAt;
      delete transformed.workEndedAt;
    }
    if (data.assignedCrew !== undefined) {
      transformed.assigned_crew = data.assignedCrew;
      delete transformed.assignedCrew;
    }
    if (data.stumpGrindingPrice !== undefined) {
      transformed.stump_grinding_price = data.stumpGrindingPrice;
      delete transformed.stumpGrindingPrice;
    }
    if (data.quoteId !== undefined) {
      transformed.quote_id = data.quoteId;
      delete transformed.quoteId;
    }
    if (data.customerName !== undefined) {
      transformed.customer_name = data.customerName;
      delete transformed.customerName;
    }
    if (data.scheduledDate !== undefined) {
      transformed.scheduled_date = data.scheduledDate;
      delete transformed.scheduledDate;
    }
    if (data.jobLocation !== undefined) {
      transformed.job_location = data.jobLocation;
      delete transformed.jobLocation;
    }
    if (data.specialInstructions !== undefined) {
      transformed.special_instructions = data.specialInstructions;
      delete transformed.specialInstructions;
    }
    if (data.requiredCrewSize !== undefined) {
      transformed.required_crew_size = data.requiredCrewSize;
      delete transformed.requiredCrewSize;
    }
    if (data.jobTemplateId !== undefined) {
      transformed.job_template_id = data.jobTemplateId;
      delete transformed.jobTemplateId;
    }
    if (data.equipmentNeeded !== undefined) {
      transformed.equipment_needed = data.equipmentNeeded;
      delete transformed.equipmentNeeded;
    }
    if (data.estimatedHours !== undefined) {
      transformed.estimated_hours = data.estimatedHours;
      delete transformed.estimatedHours;
    }
    if (data.jhaAcknowledgedAt !== undefined) {
      transformed.jha_acknowledged_at = data.jhaAcknowledgedAt;
      delete transformed.jhaAcknowledgedAt;
    }
    if (data.riskLevel !== undefined) {
      transformed.risk_level = data.riskLevel;
      delete transformed.riskLevel;
    }
    if (data.jhaRequired !== undefined) {
      transformed.jha_required = data.jhaRequired;
      delete transformed.jhaRequired;
    }
    if (data.customerPhone !== undefined) {
      transformed.customer_phone = data.customerPhone;
      delete transformed.customerPhone;
    }
    if (data.customerEmail !== undefined) {
      transformed.customer_email = data.customerEmail;
      delete transformed.customerEmail;
    }
    if (data.customerAddress !== undefined) {
      transformed.customer_address = data.customerAddress;
      delete transformed.customerAddress;
    }
    if (data.clientId !== undefined) {
      transformed.client_id = data.clientId;
      delete transformed.clientId;
    }
    if (data.propertyId !== undefined) {
      transformed.property_id = data.propertyId;
      delete transformed.propertyId;
    }
    if (data.workStartTime !== undefined) {
      transformed.work_start_time = data.workStartTime;
      delete transformed.workStartTime;
    }
    if (data.workEndTime !== undefined) {
      transformed.work_end_time = data.workEndTime;
      delete transformed.workEndTime;
    }
    if (data.invoiceId !== undefined) {
      transformed.invoice_id = data.invoiceId;
      delete transformed.invoiceId;
    }
    if (data.jobNumber !== undefined) {
      transformed.job_number = data.jobNumber;
      delete transformed.jobNumber;
    }
    if (data.predictedDurationHours !== undefined) {
      transformed.predicted_duration_hours = data.predictedDurationHours;
      delete transformed.predictedDurationHours;
    }
    if (data.permitRequired !== undefined) {
      transformed.permit_required = data.permitRequired;
      delete transformed.permitRequired;
    }
    if (data.permitStatus !== undefined) {
      transformed.permit_status = data.permitStatus;
      delete transformed.permitStatus;
    }
    if (data.permitDetails !== undefined) {
      transformed.permit_details = data.permitDetails;
      delete transformed.permitDetails;
    }
    if (data.depositRequired !== undefined) {
      transformed.deposit_required = data.depositRequired;
      delete transformed.depositRequired;
    }
    if (data.depositStatus !== undefined) {
      transformed.deposit_status = data.depositStatus;
      delete transformed.depositStatus;
    }
    if (data.depositAmount !== undefined) {
      transformed.deposit_amount = data.depositAmount;
      delete transformed.depositAmount;
    }
    if (data.weatherHoldReason !== undefined) {
      transformed.weather_hold_reason = data.weatherHoldReason;
      delete transformed.weatherHoldReason;
    }
    if (data.activeHoldUntil !== undefined) {
      transformed.active_hold_until = data.activeHoldUntil;
      delete transformed.activeHoldUntil;
    }
    if (data.lastStateChangeAt !== undefined) {
      transformed.last_state_change_at = data.lastStateChangeAt;
      delete transformed.lastStateChangeAt;
    }
    if (data.completionChecklist !== undefined) {
      transformed.completion_checklist = data.completionChecklist;
      delete transformed.completionChecklist;
    }
    if (data.paymentReceivedAt !== undefined) {
      transformed.payment_received_at = data.paymentReceivedAt;
      delete transformed.paymentReceivedAt;
    }
    if (data.jhaAcknowledgedBy !== undefined) {
      transformed.jha_acknowledged_by = data.jhaAcknowledgedBy;
      delete transformed.jhaAcknowledgedBy;
    }
    if (data.jobLat !== undefined) {
      transformed.job_lat = data.jobLat;
      delete transformed.jobLat;
    }
    if (data.jobLon !== undefined) {
      transformed.job_lon = data.jobLon;
      delete transformed.jobLon;
    }
  }
  
  // Transform pay_periods fields
  if (tableName === 'pay_periods') {
    if (data.startDate !== undefined) {
      transformed.start_date = data.startDate;
      delete transformed.startDate;
    }
    if (data.endDate !== undefined) {
      transformed.end_date = data.endDate;
      delete transformed.endDate;
    }
    if (data.periodType !== undefined) {
      transformed.period_type = data.periodType;
      delete transformed.periodType;
    }
    if (data.processedAt !== undefined) {
      transformed.processed_at = data.processedAt;
      delete transformed.processedAt;
    }
  }
  
  // Transform time_entries fields
  if (tableName === 'time_entries') {
    if (data.employeeId !== undefined) {
      transformed.employee_id = data.employeeId;
      delete transformed.employeeId;
    }
    if (data.jobId !== undefined) {
      transformed.job_id = data.jobId;
      delete transformed.jobId;
    }
    if (data.hoursWorked !== undefined) {
      transformed.hours_worked = data.hoursWorked;
      delete transformed.hoursWorked;
    }
    if (data.hourlyRate !== undefined) {
      transformed.hourly_rate = data.hourlyRate;
      delete transformed.hourlyRate;
    }
    if (data.overtimeHours !== undefined) {
      transformed.overtime_hours = data.overtimeHours;
      delete transformed.overtimeHours;
    }
  }
  
  // Transform payroll_records fields
  if (tableName === 'payroll_records') {
    if (data.employeeId !== undefined) {
      transformed.employee_id = data.employeeId;
      delete transformed.employeeId;
    }
    if (data.payPeriodId !== undefined) {
      transformed.pay_period_id = data.payPeriodId;
      delete transformed.payPeriodId;
    }
    if (data.regularHours !== undefined) {
      transformed.regular_hours = data.regularHours;
      delete transformed.regularHours;
    }
    if (data.overtimeHours !== undefined) {
      transformed.overtime_hours = data.overtimeHours;
      delete transformed.overtimeHours;
    }
    if (data.hourlyRate !== undefined) {
      transformed.hourly_rate = data.hourlyRate;
      delete transformed.hourlyRate;
    }
    if (data.regularPay !== undefined) {
      transformed.regular_pay = data.regularPay;
      delete transformed.regularPay;
    }
    if (data.overtimePay !== undefined) {
      transformed.overtime_pay = data.overtimePay;
      delete transformed.overtimePay;
    }
    if (data.totalDeductions !== undefined) {
      transformed.total_deductions = data.totalDeductions;
      delete transformed.totalDeductions;
    }
    if (data.grossPay !== undefined) {
      transformed.gross_pay = data.grossPay;
      delete transformed.grossPay;
    }
    if (data.netPay !== undefined) {
      transformed.net_pay = data.netPay;
      delete transformed.netPay;
    }
    if (data.paidAt !== undefined) {
      transformed.paid_at = data.paidAt;
      delete transformed.paidAt;
    }
    if (data.paymentMethod !== undefined) {
      transformed.payment_method = data.paymentMethod;
      delete transformed.paymentMethod;
    }
  }
  
  // Transform company_profile fields
  if (tableName === 'company_profile') {
    if (data.companyName !== undefined) {
      transformed.company_name = data.companyName;
      delete transformed.companyName;
    }
    if (data.phoneNumber !== undefined) {
      transformed.phone_number = data.phoneNumber;
      delete transformed.phoneNumber;
    }
    if (data.taxEin !== undefined) {
      transformed.tax_ein = data.taxEin;
      delete transformed.taxEin;
    }
    if (data.zipCode !== undefined) {
      transformed.zip_code = data.zipCode;
      delete transformed.zipCode;
    }
    if (data.logoUrl !== undefined) {
      transformed.logo_url = data.logoUrl;
      delete transformed.logoUrl;
    }
    if (data.businessHours !== undefined) {
      transformed.business_hours = data.businessHours;
      delete transformed.businessHours;
    }
    if (data.licenseNumber !== undefined) {
      transformed.license_number = data.licenseNumber;
      delete transformed.licenseNumber;
    }
    if (data.insurancePolicyNumber !== undefined) {
      transformed.insurance_policy_number = data.insurancePolicyNumber;
      delete transformed.insurancePolicyNumber;
    }
    if (data.updatedAt !== undefined) {
      transformed.updated_at = data.updatedAt;
      delete transformed.updatedAt;
    }
  }
  
  // Transform estimate_feedback fields
  if (tableName === 'estimate_feedback') {
    if (data.quoteId !== undefined) {
      transformed.quote_id = data.quoteId;
      delete transformed.quoteId;
    }
    if (data.aiEstimateData !== undefined && typeof data.aiEstimateData === 'object') {
      transformed.ai_estimate_data = JSON.stringify(data.aiEstimateData);
      delete transformed.aiEstimateData;
    }
    if (data.aiSuggestedPriceMin !== undefined) {
      transformed.ai_suggested_price_min = data.aiSuggestedPriceMin;
      delete transformed.aiSuggestedPriceMin;
    }
    if (data.aiSuggestedPriceMax !== undefined) {
      transformed.ai_suggested_price_max = data.aiSuggestedPriceMax;
      delete transformed.aiSuggestedPriceMax;
    }
    if (data.actualPriceQuoted !== undefined) {
      transformed.actual_price_quoted = data.actualPriceQuoted;
      delete transformed.actualPriceQuoted;
    }
    if (data.feedbackRating !== undefined) {
      transformed.feedback_rating = data.feedbackRating;
      delete transformed.feedbackRating;
    }
    if (data.correctionReasons !== undefined && typeof data.correctionReasons === 'object') {
      transformed.correction_reasons = JSON.stringify(data.correctionReasons);
      delete transformed.correctionReasons;
    }
    if (data.userNotes !== undefined) {
      transformed.user_notes = data.userNotes;
      delete transformed.userNotes;
    }
    if (data.treeSpecies !== undefined) {
      transformed.tree_species = data.treeSpecies;
      delete transformed.treeSpecies;
    }
    if (data.treeHeight !== undefined) {
      transformed.tree_height = data.treeHeight;
      delete transformed.treeHeight;
    }
    if (data.trunkDiameter !== undefined) {
      transformed.trunk_diameter = data.trunkDiameter;
      delete transformed.trunkDiameter;
    }
    if (data.jobLocation !== undefined) {
      transformed.job_location = data.jobLocation;
      delete transformed.jobLocation;
    }
    if (data.customerName !== undefined) {
      transformed.customer_name = data.customerName;
      delete transformed.customerName;
    }
    if (data.hazards !== undefined && typeof data.hazards === 'object') {
      transformed.hazards = JSON.stringify(data.hazards);
    }
  }
  
  // Transform invoices fields
  if (tableName === 'invoices') {
    if (data.jobId !== undefined) {
      transformed.job_id = data.jobId;
      delete transformed.jobId;
    }
    if (data.quoteId !== undefined) {
      transformed.quote_id = data.quoteId;
      delete transformed.quoteId;
    }
    if (data.clientId !== undefined) {
      transformed.client_id = data.clientId;
      delete transformed.clientId;
    }
    if (data.propertyId !== undefined) {
      transformed.property_id = data.propertyId;
      delete transformed.propertyId;
    }
    if (data.customerName !== undefined) {
      transformed.customer_name = data.customerName;
      delete transformed.customerName;
    }
    if (data.invoiceNumber !== undefined) {
      transformed.invoice_number = data.invoiceNumber;
      delete transformed.invoiceNumber;
    }
    if (data.issueDate !== undefined) {
      transformed.issue_date = data.issueDate;
      delete transformed.issueDate;
    }
    if (data.sentDate !== undefined) {
      transformed.sent_date = data.sentDate;
      delete transformed.sentDate;
    }
    if (data.dueDate !== undefined) {
      transformed.due_date = data.dueDate;
      delete transformed.dueDate;
    }
    if (data.paidAt !== undefined) {
      transformed.paid_at = data.paidAt;
      delete transformed.paidAt;
    }
    if (data.lineItems !== undefined) {
      transformed.line_items = data.lineItems;
      delete transformed.lineItems;
    }
    if (data.discountAmount !== undefined) {
      transformed.discount_amount = data.discountAmount;
      delete transformed.discountAmount;
    }
    if (data.discountPercentage !== undefined) {
      transformed.discount_percentage = data.discountPercentage;
      delete transformed.discountPercentage;
    }
    if (data.taxRate !== undefined) {
      transformed.tax_rate = data.taxRate;
      delete transformed.taxRate;
    }
    if (data.taxAmount !== undefined) {
      transformed.tax_amount = data.taxAmount;
      delete transformed.taxAmount;
    }
    if (data.totalAmount !== undefined) {
      transformed.total_amount = data.totalAmount;
      delete transformed.totalAmount;
    }
    if (data.grandTotal !== undefined) {
      transformed.grand_total = data.grandTotal;
      delete transformed.grandTotal;
    }
    if (data.amountPaid !== undefined) {
      transformed.amount_paid = data.amountPaid;
      delete transformed.amountPaid;
    }
    if (data.amountDue !== undefined) {
      transformed.amount_due = data.amountDue;
      delete transformed.amountDue;
    }
    if (data.paymentTerms !== undefined) {
      transformed.payment_terms = data.paymentTerms;
      delete transformed.paymentTerms;
    }
    if (data.customerEmail !== undefined) {
      transformed.customer_email = data.customerEmail;
      delete transformed.customerEmail;
    }
    if (data.customerPhone !== undefined) {
      transformed.customer_phone = data.customerPhone;
      delete transformed.customerPhone;
    }
    if (data.customerAddress !== undefined) {
      transformed.customer_address = data.customerAddress;
      delete transformed.customerAddress;
    }
    if (data.customerNotes !== undefined) {
      transformed.customer_notes = data.customerNotes;
      delete transformed.customerNotes;
    }
    if (data.updatedAt !== undefined) {
      transformed.updated_at = data.updatedAt;
      delete transformed.updatedAt;
    }
  }
  
  // Transform payment_records fields
  if (tableName === 'payment_records') {
    if (data.invoiceId !== undefined) {
      transformed.invoice_id = data.invoiceId;
      delete transformed.invoiceId;
    }
    if (data.paymentDate !== undefined) {
      transformed.payment_date = data.paymentDate;
      delete transformed.paymentDate;
    }
    if (data.paymentMethod !== undefined) {
      transformed.payment_method = data.paymentMethod;
      delete transformed.paymentMethod;
    }
    if (data.transactionId !== undefined) {
      transformed.transaction_id = data.transactionId;
      delete transformed.transactionId;
    }
    if (data.referenceNumber !== undefined) {
      transformed.reference_number = data.referenceNumber;
      delete transformed.referenceNumber;
    }
    if (data.recordedBy !== undefined) {
      transformed.recorded_by = data.recordedBy;
      delete transformed.recordedBy;
    }
  }
  
  if (data.createdAt !== undefined) {
    transformed.created_at = data.createdAt;
    delete transformed.createdAt;
  }
  
  // JSON.stringify JSONB fields to prevent "invalid input syntax for type json" errors
  // This ensures objects and arrays are properly serialized before database insertion
  
  // Jobs table JSONB fields
  if (tableName === 'jobs') {
    if (transformed.assigned_crew !== undefined && typeof transformed.assigned_crew === 'object') {
      transformed.assigned_crew = JSON.stringify(transformed.assigned_crew);
    }
    if (transformed.completion_checklist !== undefined && typeof transformed.completion_checklist === 'object') {
      transformed.completion_checklist = JSON.stringify(transformed.completion_checklist);
    }
    if (transformed.equipment_needed !== undefined && typeof transformed.equipment_needed === 'object') {
      transformed.equipment_needed = JSON.stringify(transformed.equipment_needed);
    }
    if (transformed.permit_details !== undefined && typeof transformed.permit_details === 'object') {
      transformed.permit_details = JSON.stringify(transformed.permit_details);
    }
  }
  
  // Quotes table JSONB fields
  if (tableName === 'quotes') {
    if (transformed.line_items !== undefined && typeof transformed.line_items === 'object') {
      transformed.line_items = JSON.stringify(transformed.line_items);
    }
  }
  
  // Employees table JSONB fields
  if (tableName === 'employees') {
    if (transformed.performance_metrics !== undefined && typeof transformed.performance_metrics === 'object') {
      transformed.performance_metrics = JSON.stringify(transformed.performance_metrics);
    }
  }
  
  // Equipment table JSONB fields
  if (tableName === 'equipment') {
    if (transformed.maintenance_history !== undefined && typeof transformed.maintenance_history === 'object') {
      transformed.maintenance_history = JSON.stringify(transformed.maintenance_history);
    }
  }
  
  // Invoices table JSONB fields
  if (tableName === 'invoices') {
    if (transformed.line_items !== undefined && typeof transformed.line_items === 'object') {
      transformed.line_items = JSON.stringify(transformed.line_items);
    }
  }
  
  return transformed;
};

const setupCrudEndpoints = (router, tableName) => {
  // GET all
  router.get(`/${tableName}`, async (req, res) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${tableName}`);
      const transformed = rows.map(row => transformRow(row, tableName));
      res.json(transformed);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET by ID
  router.get(`/${tableName}/:id`, async (req, res) => {
    try {
      const { rows } = await db.query(`SELECT * FROM ${tableName} WHERE id = $1`, [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(transformRow(rows[0], tableName));
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST new
  router.post(`/${tableName}`, async (req, res) => {
    try {
      const data = transformToDb(req.body, tableName);
      const columns = Object.keys(data);
      const values = Object.values(data);
      const placeholders = columns.map((_, i) => `$${i + 2}`).join(', ');
      const newId = uuidv4();

      const queryText = `INSERT INTO ${tableName} (id, ${columns.join(', ')}) VALUES ($1, ${placeholders}) RETURNING *`;
      const { rows } = await db.query(queryText, [newId, ...values]);
      const result = transformRow(rows[0], tableName);
      res.status(201).json(result);

      reindexDocument(tableName, rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  // PUT update by ID
  router.put(`/${tableName}/:id`, async (req, res) => {
    try {
      const data = transformToDb(req.body, tableName);
      const columns = Object.keys(data);
      const values = Object.values(data);
      const setString = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');

      const queryText = `UPDATE ${tableName} SET ${setString} WHERE id = $1 RETURNING *`;
      const { rows } = await db.query(queryText, [req.params.id, ...values]);

      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      const result = transformRow(rows[0], tableName);
      res.json(result);

      reindexDocument(tableName, rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE by ID
  router.delete(`/${tableName}/:id`, async (req, res) => {
    try {
      const result = await db.query(`DELETE FROM ${tableName} WHERE id = $1`, [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      res.status(204).send();

      removeFromVectorStore(tableName, req.params.id);
      console.log(`[RAG] Document ${req.params.id} deleted from ${tableName}.`);
    } catch (err) {
      handleError(res, err);
    }
  });
};

apiRouter.post('/pay_periods/:id/process', async (req, res) => {
  try {
    const { rows: payPeriodRows } = await db.query(
      'SELECT * FROM pay_periods WHERE id = $1',
      [req.params.id]
    );
    
    if (payPeriodRows.length === 0) {
      return res.status(404).json({ error: 'Pay period not found' });
    }
    
    const payPeriod = payPeriodRows[0];
    
    if (payPeriod.status === 'Closed') {
      return res.status(400).json({ error: 'Pay period already processed' });
    }
    
    const { rows: timeEntries } = await db.query(
      `SELECT * FROM time_entries 
       WHERE date >= $1 AND date <= $2`,
      [payPeriod.start_date, payPeriod.end_date]
    );
    
    const employeeEntries = {};
    for (const entry of timeEntries) {
      if (!employeeEntries[entry.employee_id]) {
        employeeEntries[entry.employee_id] = [];
      }
      employeeEntries[entry.employee_id].push(entry);
    }
    
    const payrollRecords = [];
    let totalGrossPay = 0;
    let totalNetPay = 0;
    
    for (const employeeId in employeeEntries) {
      const entries = employeeEntries[employeeId];
      
      const { rows: employeeRows } = await db.query(
        'SELECT * FROM employees WHERE id = $1',
        [employeeId]
      );
      
      if (employeeRows.length === 0) {
        continue;
      }
      
      const employee = employeeRows[0];
      const hourlyRate = parseFloat(employee.pay_rate || 0);
      
      let totalHoursWorked = 0;
      let totalOvertimeHours = 0;
      
      for (const entry of entries) {
        totalHoursWorked += parseFloat(entry.hours_worked || 0);
        totalOvertimeHours += parseFloat(entry.overtime_hours || 0);
      }
      
      const regularHours = Math.max(totalHoursWorked - totalOvertimeHours, 0);
      const overtimeHours = totalOvertimeHours;
      
      const regularPay = regularHours * hourlyRate;
      const overtimePay = overtimeHours * (hourlyRate * 1.5);
      const bonuses = 0;
      const grossPay = regularPay + overtimePay + bonuses;
      
      const federalTax = grossPay * 0.15;
      const stateTax = grossPay * 0.05;
      const socialSecurity = grossPay * 0.062;
      const medicare = grossPay * 0.0145;
      
      const deductions = [
        { type: 'Federal Tax', amount: federalTax, percentage: 15 },
        { type: 'State Tax', amount: stateTax, percentage: 5 },
        { type: 'Social Security', amount: socialSecurity, percentage: 6.2 },
        { type: 'Medicare', amount: medicare, percentage: 1.45 }
      ];
      
      const totalDeductions = federalTax + stateTax + socialSecurity + medicare;
      const netPay = grossPay - totalDeductions;
      
      const payrollId = uuidv4();
      const { rows: payrollRows } = await db.query(
        `INSERT INTO payroll_records (
          id, employee_id, pay_period_id, regular_hours, overtime_hours,
          hourly_rate, regular_pay, overtime_pay, bonuses, deductions,
          total_deductions, gross_pay, net_pay, payment_method
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`,
        [
          payrollId, employeeId, req.params.id, regularHours, overtimeHours,
          hourlyRate, regularPay, overtimePay, bonuses, JSON.stringify(deductions),
          totalDeductions, grossPay, netPay, 'Direct Deposit'
        ]
      );
      
      payrollRecords.push(transformRow(payrollRows[0], 'payroll_records'));
      totalGrossPay += grossPay;
      totalNetPay += netPay;
    }
    
    const now = new Date().toISOString();
    const { rows: updatedPayPeriodRows } = await db.query(
      `UPDATE pay_periods SET status = $1, processed_at = $2 WHERE id = $3 RETURNING *`,
      ['Closed', now, req.params.id]
    );
    
    res.json({
      payPeriod: transformRow(updatedPayPeriodRows[0], 'pay_periods'),
      payrollRecords: payrollRecords,
      summary: {
        totalEmployees: payrollRecords.length,
        totalGrossPay: totalGrossPay,
        totalNetPay: totalNetPay
      }
    });
  } catch (err) {
    handleError(res, err);
  }
});

// Company Profile Endpoints (singleton pattern)
apiRouter.get('/company-profile', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM company_profile LIMIT 1');
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Company profile not found' });
    }
    res.json(transformRow(rows[0], 'company_profile'));
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.put('/company-profile', async (req, res) => {
  try {
    const { rows: existingRows } = await db.query('SELECT * FROM company_profile LIMIT 1');
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Company profile not found' });
    }
    
    const data = transformToDb(req.body, 'company_profile');
    
    const allowedColumns = [
      'company_name', 'legal_name', 'phone_number', 'email', 'address', 
      'city', 'state', 'zip_code', 'website', 'logo_url', 'tagline', 
      'business_hours', 'license_number', 'insurance_policy_number', 
      'tax_ein', 'about', 'services', 'updated_at'
    ];
    
    const columns = Object.keys(data).filter(col => allowedColumns.includes(col));
    const values = columns.map(col => data[col]);
    const setString = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
    
    const queryText = `UPDATE company_profile SET ${setString}, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const { rows } = await db.query(queryText, [existingRows[0].id, ...values]);
    
    res.json(transformRow(rows[0], 'company_profile'));
  } catch (err) {
    handleError(res, err);
  }
});

// Angi Ads Webhook Endpoint
apiRouter.post('/webhooks/angi', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const expectedApiKey = process.env.ANGI_ADS_WEBHOOK_SECRET;

    if (!apiKey || apiKey !== expectedApiKey) {
      console.log('Angi Ads webhook: Invalid or missing API key');
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing API key' });
    }

    const { name, phone, email, comments, description, address, location, timestamp, leadId } = req.body;

    if (!name || !phone || !email) {
      console.log('Angi Ads webhook: Missing required fields');
      return res.status(400).json({ error: 'Bad Request', message: 'Missing required fields: name, phone, email' });
    }

    console.log(`Angi Ads webhook: Received lead from Angi Ads - ${name} (${email})`);

    const customerAddress = address || location || '';
    const leadDescription = comments || description || '';
    let clientId;
    let customerName = name;

    const { rows: existingClients } = await db.query(
      `SELECT * FROM clients WHERE primary_email = $1 OR primary_phone = $2 LIMIT 1`,
      [email, phone]
    );

    if (existingClients.length > 0) {
      clientId = existingClients[0].id;
      customerName = existingClients[0].first_name && existingClients[0].last_name 
        ? `${existingClients[0].first_name} ${existingClients[0].last_name}`.trim()
        : existingClients[0].first_name || existingClients[0].last_name || existingClients[0].company_name || name;
      console.log(`Angi Ads webhook: Found existing client ${clientId}`);
    } else {
      clientId = uuidv4();
      const nameParts = name.trim().split(' ');
      const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : null;
      const lastName = nameParts.length > 0 ? nameParts[nameParts.length - 1] : null;
      
      const { rows: newClientRows } = await db.query(
        `INSERT INTO clients (id, first_name, last_name, primary_email, primary_phone, billing_address_line1, status, client_type) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [clientId, firstName, lastName, email, phone, customerAddress, 'active', 'residential']
      );
      console.log(`Angi Ads webhook: Created new client ${clientId}`);
    }

    const newLeadId = uuidv4();
    const leadDescriptionWithAngiId = leadDescription 
      ? `${leadDescription}\n\nAngi Lead ID: ${leadId || 'N/A'}` 
      : `Angi Lead ID: ${leadId || 'N/A'}`;

    const { rows: newLeadRows } = await db.query(
      `INSERT INTO leads (id, client_id, source, status, description, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newLeadId, clientId, 'Angi Ads', 'New', leadDescriptionWithAngiId, new Date().toISOString()]
    );

    console.log(`Angi Ads webhook: Created new lead ${newLeadId} for client ${clientId}`);

    res.status(200).json({
      success: true,
      leadId: newLeadId,
      clientId: clientId
    });

  } catch (err) {
    console.error('Angi Ads webhook error:', err);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: err.message 
    });
  }
});


apiRouter.post('/rag/search', async (req, res) => {
  try {
    const { query, collections, limit } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const results = await ragService.search(query, { collections, limit });
    res.json({ results });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.post('/rag/context', async (req, res) => {
  try {
    const { query, maxResults } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const context = await ragService.getContextForQuery(query, maxResults);
    res.json({ context });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.post('/rag/build', async (req, res) => {
  try {
    console.log('🔄 Starting vector database build...');
    const stats = await ragService.buildVectorDatabase();
    res.json({ 
      success: true, 
      message: 'Vector database built successfully',
      stats 
    });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.get('/rag/stats', async (req, res) => {
  try {
    const vectorStore = require('./services/vectorStore');
    const stats = await vectorStore.getCollectionStats();
    res.json({ stats });
  } catch (err) {
    handleError(res, err);
  }
});

// Estimate Feedback Analytics endpoint
apiRouter.get('/estimate_feedback/stats', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM estimate_feedback ORDER BY created_at DESC`);
    
    if (rows.length === 0) {
      return res.json({
        totalFeedback: 0,
        accurateCount: 0,
        tooLowCount: 0,
        tooHighCount: 0,
        accuracyRate: 0,
        averagePriceDifference: 0,
        commonCorrectionReasons: [],
        feedbackByTreeSize: {
          small: { count: 0, avgDifference: 0 },
          medium: { count: 0, avgDifference: 0 },
          large: { count: 0, avgDifference: 0 },
          extraLarge: { count: 0, avgDifference: 0 }
        }
      });
    }

    const totalFeedback = rows.length;
    const accurateCount = rows.filter(r => r.feedback_rating === 'accurate').length;
    const tooLowCount = rows.filter(r => r.feedback_rating === 'too_low').length;
    const tooHighCount = rows.filter(r => r.feedback_rating === 'too_high').length;
    const accuracyRate = (accurateCount / totalFeedback) * 100;

    // Calculate average price difference
    const feedbackWithActual = rows.filter(r => r.actual_price_quoted !== null);
    const avgDiff = feedbackWithActual.length > 0
      ? feedbackWithActual.reduce((sum, r) => {
          const aiMid = (parseFloat(r.ai_suggested_price_min) + parseFloat(r.ai_suggested_price_max)) / 2;
          return sum + Math.abs(parseFloat(r.actual_price_quoted) - aiMid);
        }, 0) / feedbackWithActual.length
      : 0;

    // Count correction reasons
    const reasonCounts = {};
    rows.forEach(r => {
      if (r.correction_reasons && Array.isArray(r.correction_reasons)) {
        r.correction_reasons.forEach(reason => {
          reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
        });
      }
    });
    const commonCorrectionReasons = Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Group by tree size
    const feedbackByTreeSize = {
      small: { count: 0, totalDiff: 0, avgDifference: 0 },
      medium: { count: 0, totalDiff: 0, avgDifference: 0 },
      large: { count: 0, totalDiff: 0, avgDifference: 0 },
      extraLarge: { count: 0, totalDiff: 0, avgDifference: 0 }
    };

    feedbackWithActual.forEach(r => {
      const height = parseFloat(r.tree_height) || 0;
      const aiMid = (parseFloat(r.ai_suggested_price_min) + parseFloat(r.ai_suggested_price_max)) / 2;
      const diff = Math.abs(parseFloat(r.actual_price_quoted) - aiMid);
      
      let sizeCategory;
      if (height < 30) sizeCategory = 'small';
      else if (height < 60) sizeCategory = 'medium';
      else if (height < 80) sizeCategory = 'large';
      else sizeCategory = 'extraLarge';

      feedbackByTreeSize[sizeCategory].count++;
      feedbackByTreeSize[sizeCategory].totalDiff += diff;
    });

    // Calculate averages
    Object.keys(feedbackByTreeSize).forEach(size => {
      const data = feedbackByTreeSize[size];
      data.avgDifference = data.count > 0 ? data.totalDiff / data.count : 0;
      delete data.totalDiff;
    });

    res.json({
      totalFeedback,
      accurateCount,
      tooLowCount,
      tooHighCount,
      accuracyRate: Math.round(accuracyRate * 10) / 10,
      averagePriceDifference: Math.round(avgDiff * 100) / 100,
      commonCorrectionReasons,
      feedbackByTreeSize
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// CLIENT CRUD API ENDPOINTS
// ============================================================================

const CLIENT_CATEGORIES = {
  POTENTIAL: 'potential_client',
  ACTIVE: 'active_customer'
};

const normalizeText = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeEmail = (value) => {
  const trimmed = normalizeText(value);
  return trimmed ? trimmed.toLowerCase() : null;
};

const normalizePhone = (value) => {
  if (!value) return null;
  const digits = value.toString().replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : null;
};

const setClientCategory = async (clientId, category) => {
  if (!clientId || !category) {
    return;
  }

  await db.query(
    `UPDATE clients
       SET client_category = $1,
           updated_at = NOW()
     WHERE id = $2
       AND (client_category IS DISTINCT FROM $1 OR client_category IS NULL)`,
    [category, clientId]
  );
};

const updateClientCategoryFromJobs = async (clientId) => {
  if (!clientId) return;

  const { rows } = await db.query(
    `SELECT COUNT(*) AS completed_jobs
       FROM jobs
      WHERE client_id = $1
        AND LOWER(status) = 'completed'`,
    [clientId]
  );

  const completedJobs = parseInt(rows[0]?.completed_jobs || 0, 10);
  const nextCategory = completedJobs > 0 ? CLIENT_CATEGORIES.ACTIVE : CLIENT_CATEGORIES.POTENTIAL;
  await setClientCategory(clientId, nextCategory);
};

const markClientAsPotential = async (clientId) => {
  if (!clientId) return;

  const { rows } = await db.query(
    `SELECT COUNT(*) AS completed_jobs
       FROM jobs
      WHERE client_id = $1
        AND LOWER(status) = 'completed'`,
    [clientId]
  );

  const completedJobs = parseInt(rows[0]?.completed_jobs || 0, 10);
  if (completedJobs === 0) {
    await setClientCategory(clientId, CLIENT_CATEGORIES.POTENTIAL);
  }
};

const ensureClientAssociation = async ({ clientId, customerDetails = {}, defaultClientType = 'residential' }) => {
  const sanitizedClientId = sanitizeUUID(clientId);
  const normalizedDetails = {
    first_name: normalizeText(customerDetails.firstName),
    last_name: normalizeText(customerDetails.lastName),
    company_name: normalizeText(customerDetails.companyName),
    primary_email: normalizeEmail(customerDetails.email),
    primary_phone: normalizePhone(customerDetails.phone),
    billing_address_line1: normalizeText(customerDetails.addressLine1),
    billing_address_line2: normalizeText(customerDetails.addressLine2),
    billing_city: normalizeText(customerDetails.city),
    billing_state: normalizeText(customerDetails.state),
    billing_zip_code_code: normalizeText(customerDetails.zipCode),
    billing_country: normalizeText(customerDetails.country) || 'USA'
  };

  let clientRow = null;

  if (sanitizedClientId) {
    const { rows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [sanitizedClientId]
    );
    clientRow = rows[0] || null;
  }

  if (!clientRow) {
    const conditions = [];
    const params = [];
    if (normalizedDetails.primary_email) {
      conditions.push(`LOWER(primary_email) = $${params.length + 1}`);
      params.push(normalizedDetails.primary_email);
    }
    if (normalizedDetails.primary_phone) {
      conditions.push(`REGEXP_REPLACE(COALESCE(primary_phone, ''), '[^0-9]', '', 'g') = $${params.length + 1}`);
      params.push(normalizedDetails.primary_phone);
    }

    if (conditions.length > 0) {
      const { rows } = await db.query(
        `SELECT * FROM clients WHERE deleted_at IS NULL AND (${conditions.join(' OR ')}) LIMIT 1`,
        params
      );
      clientRow = rows[0] || null;
    }
  }

  if (clientRow) {
    const updates = {};
    Object.entries(normalizedDetails).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        updates[key] = value;
      }
    });

    if (Object.keys(updates).length > 0) {
      const columns = Object.keys(updates);
      const values = Object.values(updates);
      const setString = columns.map((col, index) => `${col} = $${index + 2}`).join(', ');
      await db.query(
        `UPDATE clients SET ${setString}, updated_at = NOW() WHERE id = $1`,
        [clientRow.id, ...values]
      );

      const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [clientRow.id]);
      clientRow = rows[0];
    }

    await markClientAsPotential(clientRow.id);
    return { clientId: clientRow.id, client: clientRow, created: false };
  }

  if (!normalizedDetails.first_name && !normalizedDetails.last_name && !normalizedDetails.company_name) {
    throw new Error('Client name or company is required to create a record');
  }

  const newClientId = sanitizedClientId || uuidv4();
  const insertData = {
    id: newClientId,
    first_name: normalizedDetails.first_name,
    last_name: normalizedDetails.last_name,
    company_name: normalizedDetails.company_name,
    primary_email: normalizedDetails.primary_email,
    primary_phone: normalizedDetails.primary_phone,
    billing_address_line1: normalizedDetails.billing_address_line1,
    billing_address_line2: normalizedDetails.billing_address_line2,
    billing_city: normalizedDetails.billing_city,
    billing_state: normalizedDetails.billing_state,
    billing_zip_code_code: normalizedDetails.billing_zip_code_code,
    billing_country: normalizedDetails.billing_country,
    status: 'active',
    client_type: defaultClientType,
    client_category: CLIENT_CATEGORIES.POTENTIAL,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const columns = Object.keys(insertData).filter((key) => insertData[key] !== undefined);
  const values = columns.map((key) => insertData[key]);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  const { rows } = await db.query(
    `INSERT INTO clients (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values
  );

  clientRow = rows[0];
  await markClientAsPotential(clientRow.id);
  return { clientId: clientRow.id, client: clientRow, created: true };
};

// Helper function: Build client stats
const buildClientStats = async (clientId) => {
  try {
    const statsQuery = `
      SELECT
        (SELECT COUNT(*) FROM quotes WHERE client_id = $1 AND deleted_at IS NULL) as total_quotes,
        (SELECT COUNT(*) FROM jobs WHERE client_id = $1) as total_jobs,
        (SELECT COUNT(*) FROM invoices WHERE client_id = $1 AND status = 'Paid') as total_invoices,
        (SELECT COALESCE(SUM(COALESCE(grand_total, total_amount, amount)::numeric), 0)
           FROM invoices WHERE client_id = $1 AND status = 'Paid') as lifetime_value,
        (SELECT MAX(scheduled_date) FROM jobs WHERE client_id = $1) as last_job_date
    `;

    const { rows } = await db.query(statsQuery, [clientId]);
    return {
      totalQuotes: parseInt(rows[0]?.total_quotes || 0),
      totalJobs: parseInt(rows[0]?.total_jobs || 0),
      totalInvoices: parseInt(rows[0]?.total_invoices || 0),
      lifetimeValue: parseFloat(rows[0]?.lifetime_value || 0),
      lastJobDate: rows[0]?.last_job_date || null
    };
  } catch (err) {
    console.error('Error building client stats:', err);
    return {
      totalQuotes: 0,
      totalJobs: 0,
      totalInvoices: 0,
      lifetimeValue: 0,
      lastJobDate: null
    };
  }
};

// Helper function: Validate client input
const validateClientInput = (data) => {
  const errors = [];
  
  if (data.primaryEmail) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.primaryEmail)) {
      errors.push('Invalid email format');
    }
  }
  
  if (!data.firstName && !data.companyName) {
    errors.push('Either firstName or companyName is required');
  }
  
  return errors;
};

// POST /api/clients - Create new client
apiRouter.post('/clients', async (req, res) => {
  try {
    const clientData = req.body;
    
    // Validate input
    const validationErrors = validateClientInput(clientData);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Validation failed', 
        details: validationErrors 
      });
    }
    
    // Start transaction
    await db.query('BEGIN');
    
    try {
      // Convert camelCase to snake_case for database
      const dbData = camelToSnake(clientData);
      
      // Extract nested data
      const properties = clientData.properties || [];
      const contacts = clientData.contacts || [];
      const tags = clientData.tags || [];
      
      // Remove nested arrays from main data
      delete dbData.properties;
      delete dbData.contacts;
      delete dbData.tags;
      
      // Generate UUID and set defaults
      const clientId = uuidv4();
      dbData.id = clientId;
      dbData.status = dbData.status || 'active';
      dbData.client_type = dbData.client_type || 'residential';
      dbData.client_category = dbData.client_category || CLIENT_CATEGORIES.POTENTIAL;
      
      // Insert client
      const clientColumns = Object.keys(dbData).filter(k => k !== 'id');
      const clientValues = clientColumns.map(k => dbData[k]);
      const clientPlaceholders = clientColumns.map((_, i) => `$${i + 2}`).join(', ');
      
      const clientQuery = `
        INSERT INTO clients (id, ${clientColumns.join(', ')}) 
        VALUES ($1, ${clientPlaceholders}) 
        RETURNING *
      `;
      
      const { rows: clientRows } = await db.query(clientQuery, [clientId, ...clientValues]);
      const createdClient = clientRows[0];
      
      // Insert properties
      const createdProperties = [];
      for (const property of properties) {
        const propertyId = uuidv4();
        const propData = camelToSnake(property);
        propData.id = propertyId;
        propData.client_id = clientId;
        
        const propColumns = Object.keys(propData).filter(k => k !== 'id');
        const propValues = propColumns.map(k => propData[k]);
        const propPlaceholders = propColumns.map((_, i) => `$${i + 2}`).join(', ');
        
        const propQuery = `
          INSERT INTO properties (id, ${propColumns.join(', ')}) 
          VALUES ($1, ${propPlaceholders}) 
          RETURNING *
        `;
        
        const { rows: propRows } = await db.query(propQuery, [propertyId, ...propValues]);
        createdProperties.push(propRows[0]);
      }
      
      // Insert contacts
      const createdContacts = [];
      for (const contact of contacts) {
        const contactId = uuidv4();
        const contactData = camelToSnake(contact);
        contactData.id = contactId;
        contactData.client_id = clientId;
        
        // Extract channels
        const channels = contact.channels || [];
        delete contactData.channels;
        
        const contactColumns = Object.keys(contactData).filter(k => k !== 'id');
        const contactValues = contactColumns.map(k => contactData[k]);
        const contactPlaceholders = contactColumns.map((_, i) => `$${i + 2}`).join(', ');
        
        const contactQuery = `
          INSERT INTO contacts (id, ${contactColumns.join(', ')}) 
          VALUES ($1, ${contactPlaceholders}) 
          RETURNING *
        `;
        
        const { rows: contactRows } = await db.query(contactQuery, [contactId, ...contactValues]);
        const createdContact = contactRows[0];
        
        // Insert contact channels
        const createdChannels = [];
        for (const channel of channels) {
          const channelId = uuidv4();
          const channelData = camelToSnake(channel);
          channelData.id = channelId;
          channelData.contact_id = contactId;
          
          const channelQuery = `
            INSERT INTO contact_channels (id, contact_id, channel_type, channel_value, label, is_primary, is_verified)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `;
          
          const { rows: channelRows } = await db.query(channelQuery, [
            channelId,
            contactId,
            channelData.channel_type,
            channelData.channel_value,
            channelData.label || null,
            channelData.is_primary || false,
            channelData.is_verified || false
          ]);
          createdChannels.push(channelRows[0]);
        }
        
        createdContact.channels = createdChannels;
        createdContacts.push(createdContact);
      }
      
      // Insert tags
      const createdTags = [];
      for (const tagName of tags) {
        // Find or create tag
        let tagId;
        const { rows: existingTags } = await db.query(
          'SELECT id FROM tags WHERE name = $1',
          [tagName]
        );
        
        if (existingTags.length > 0) {
          tagId = existingTags[0].id;
        } else {
          tagId = uuidv4();
          await db.query(
            'INSERT INTO tags (id, name, category) VALUES ($1, $2, $3)',
            [tagId, tagName, 'client']
          );
        }
        
        // Link tag to client
        await db.query(
          'INSERT INTO entity_tags (id, tag_id, entity_type, entity_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [uuidv4(), tagId, 'client', clientId]
        );
        
        createdTags.push({ id: tagId, name: tagName });
      }
      
      // Commit transaction
      await db.query('COMMIT');
      
      // Build response with nested data
      const response = snakeToCamel(createdClient);
      response.properties = createdProperties.map(snakeToCamel);
      response.contacts = createdContacts.map(snakeToCamel);
      response.tags = createdTags;
      
      res.status(201).json({ success: true, data: response });
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/clients - List clients with filtering and pagination
apiRouter.get('/clients', async (req, res) => {
  try {
    const {
      status,
      clientType,
      clientCategory,
      search,
      tags,
      page = 1,
      limit = 50,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = req.query;
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = ['deleted_at IS NULL'];
    const params = [];
    let paramIndex = 1;
    
    // Status filter
    if (status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    
    // Client type filter
    if (clientType) {
      conditions.push(`client_type = $${paramIndex}`);
      params.push(clientType);
      paramIndex++;
    }
    
    // Client category filter
    if (clientCategory) {
      conditions.push(`client_category = $${paramIndex}`);
      params.push(clientCategory);
      paramIndex++;
    }

    // Full-text search
    if (search) {
      conditions.push(`(
        to_tsvector('english', 
          coalesce(first_name, '') || ' ' || 
          coalesce(last_name, '') || ' ' || 
          coalesce(company_name, '') || ' ' || 
          coalesce(primary_email, '')
        ) @@ plainto_tsquery('english', $${paramIndex})
        OR first_name ILIKE $${paramIndex + 1}
        OR last_name ILIKE $${paramIndex + 1}
        OR company_name ILIKE $${paramIndex + 1}
        OR primary_email ILIKE $${paramIndex + 1}
      )`);
      params.push(search, `%${search}%`);
      paramIndex += 2;
    }
    
    // Tag filter
    if (tags) {
      const tagArray = tags.split(',');
      conditions.push(`id IN (
        SELECT entity_id FROM entity_tags 
        WHERE entity_type = 'client' 
        AND tag_id IN (SELECT id FROM tags WHERE name = ANY($${paramIndex}))
      )`);
      params.push(tagArray);
      paramIndex++;
    }
    
    // Build WHERE clause
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Validate sortBy to prevent SQL injection
    const validSortColumns = ['created_at', 'updated_at', 'first_name', 'last_name', 'company_name', 'lifetime_value', 'client_category'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    
    // Get total count
    const countQuery = `SELECT COUNT(*) FROM clients ${whereClause}`;
    const { rows: countRows } = await db.query(countQuery, params);
    const totalCount = parseInt(countRows[0].count);
    
    // Get clients with basic stats
    const clientsQuery = `
      SELECT
        c.*,
        (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id) as job_count,
        (SELECT COUNT(*) FROM quotes q WHERE q.client_id = c.id AND q.deleted_at IS NULL) as quote_count,
        (SELECT COALESCE(SUM(COALESCE(grand_total, total_amount, amount)::numeric), 0)
           FROM invoices i WHERE i.client_id = c.id AND i.status = 'Paid') as calculated_lifetime_value
      FROM clients c
      ${whereClause}
      ORDER BY ${sortColumn} ${sortDirection}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    const { rows: clients } = await db.query(clientsQuery, [...params, parseInt(limit), offset]);
    
    // Transform to camelCase and add stats
    const transformedClients = clients.map(client => {
      const transformed = snakeToCamel(client);
      transformed.stats = {
        jobCount: parseInt(client.job_count || 0),
        quoteCount: parseInt(client.quote_count || 0),
        lifetimeValue: parseFloat(client.calculated_lifetime_value || client.lifetime_value || 0)
      };
      delete transformed.jobCount;
      delete transformed.quoteCount;
      delete transformed.calculatedLifetimeValue;
      return transformed;
    });
    
    res.json({
      success: true,
      data: transformedClients,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit))
      }
    });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/clients/:id - Get single client with full details
apiRouter.get('/clients/:id', async (req, res) => {
  try {
    const clientId = req.params.id;
    
    // Get client
    const { rows: clientRows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    
    if (clientRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }
    
    const client = snakeToCamel(clientRows[0]);
    
    // Get properties
    const { rows: propertyRows } = await db.query(
      'SELECT * FROM properties WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    client.properties = propertyRows.map(snakeToCamel);
    
    // Get contacts with channels
    const { rows: contactRows } = await db.query(
      'SELECT * FROM contacts WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    
    const contacts = [];
    for (const contact of contactRows) {
      const transformedContact = snakeToCamel(contact);
      
      // Get channels for this contact
      const { rows: channelRows } = await db.query(
        'SELECT * FROM contact_channels WHERE contact_id = $1',
        [contact.id]
      );
      transformedContact.channels = channelRows.map(snakeToCamel);
      
      contacts.push(transformedContact);
    }
    client.contacts = contacts;
    
    // Get tags
    const { rows: tagRows } = await db.query(`
      SELECT t.id, t.name, t.color, t.category
      FROM tags t
      INNER JOIN entity_tags et ON t.id = et.tag_id
      WHERE et.entity_type = 'client' AND et.entity_id = $1
    `, [clientId]);
    client.tags = tagRows.map(snakeToCamel);
    
    // Get custom field values
    const { rows: customFieldRows } = await db.query(`
      SELECT 
        cfv.id,
        cfv.field_value,
        cfd.field_name,
        cfd.field_label,
        cfd.field_type
      FROM custom_field_values cfv
      INNER JOIN custom_field_definitions cfd ON cfv.field_definition_id = cfd.id
      WHERE cfv.entity_type = 'client' AND cfv.entity_id = $1
    `, [clientId]);
    client.customFields = customFieldRows.map(snakeToCamel);
    
    // Get stats
    client.stats = await buildClientStats(clientId);
    
    res.json({ success: true, data: client });
    
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/clients/:id - Update client
apiRouter.put('/clients/:id', async (req, res) => {
  try {
    const clientId = req.params.id;
    const clientData = req.body;
    
    // Validate input
    const validationErrors = validateClientInput(clientData);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Validation failed', 
        details: validationErrors 
      });
    }
    
    // Check if client exists
    const { rows: existingRows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    
    if (existingRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }
    
    // Check email uniqueness if email is being changed
    if (clientData.primaryEmail && clientData.primaryEmail !== existingRows[0].primary_email) {
      const { rows: emailCheckRows } = await db.query(
        'SELECT id FROM clients WHERE primary_email = $1 AND id != $2 AND deleted_at IS NULL',
        [clientData.primaryEmail, clientId]
      );
      
      if (emailCheckRows.length > 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Email already exists for another client' 
        });
      }
    }
    
    // Convert to snake_case and remove nested data
    const dbData = camelToSnake(clientData);
    delete dbData.properties;
    delete dbData.contacts;
    delete dbData.tags;
    delete dbData.customFields;
    delete dbData.stats;
    delete dbData.id;
    delete dbData.created_at;
    delete dbData.deleted_at;
    
    // Build update query
    const columns = Object.keys(dbData);
    const values = columns.map(k => dbData[k]);
    const setString = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
    
    const updateQuery = `
      UPDATE clients 
      SET ${setString}, updated_at = NOW() 
      WHERE id = $1 
      RETURNING *
    `;
    
    const { rows: updatedRows } = await db.query(updateQuery, [clientId, ...values]);
    
    // Get full client details to return
    const response = await db.query(
      'SELECT * FROM clients WHERE id = $1',
      [clientId]
    );
    
    const client = snakeToCamel(response.rows[0]);
    
    // Get nested data
    const { rows: propertyRows } = await db.query(
      'SELECT * FROM properties WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    client.properties = propertyRows.map(snakeToCamel);
    
    const { rows: contactRows } = await db.query(
      'SELECT * FROM contacts WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    
    const contacts = [];
    for (const contact of contactRows) {
      const transformedContact = snakeToCamel(contact);
      const { rows: channelRows } = await db.query(
        'SELECT * FROM contact_channels WHERE contact_id = $1',
        [contact.id]
      );
      transformedContact.channels = channelRows.map(snakeToCamel);
      contacts.push(transformedContact);
    }
    client.contacts = contacts;
    
    const { rows: tagRows } = await db.query(`
      SELECT t.id, t.name, t.color, t.category
      FROM tags t
      INNER JOIN entity_tags et ON t.id = et.tag_id
      WHERE et.entity_type = 'client' AND et.entity_id = $1
    `, [clientId]);
    client.tags = tagRows.map(snakeToCamel);
    
    res.json({ success: true, data: client });
    
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/clients/:id - Soft delete client
apiRouter.delete('/clients/:id', async (req, res) => {
  try {
    const clientId = req.params.id;
    
    // Check if client exists
    const { rows: clientRows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    
    if (clientRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }
    
    // Check if client has jobs
    const clientName = `${clientRows[0].first_name} ${clientRows[0].last_name}`.trim() || clientRows[0].company_name;
    const { rows: jobRows } = await db.query(
      'SELECT COUNT(*) as count FROM jobs WHERE customer_name = $1',
      [clientName]
    );
    
    if (parseInt(jobRows[0].count) > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete client with existing jobs' 
      });
    }
    
    // Soft delete client
    await db.query(
      'UPDATE clients SET deleted_at = NOW() WHERE id = $1',
      [clientId]
    );
    
    // Soft delete related properties
    await db.query(
      'UPDATE properties SET deleted_at = NOW() WHERE client_id = $1',
      [clientId]
    );
    
    res.status(204).send();
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// PROPERTY CRUD API ENDPOINTS
// ============================================================================

// GET /api/clients/:clientId/properties - Get all properties for a client
apiRouter.get('/clients/:clientId/properties', async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Validate client exists
    const { rows: clientRows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    
    if (clientRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }
    
    // Fetch all properties for this client
    const { rows } = await db.query(
      `SELECT * FROM properties 
       WHERE client_id = $1 AND deleted_at IS NULL 
       ORDER BY is_primary DESC, created_at DESC`,
      [clientId]
    );
    
    const properties = rows.map(row => snakeToCamel(row));
    
    res.json({ 
      success: true, 
      data: properties 
    });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/clients/:clientId/properties - Add property to client
apiRouter.post('/clients/:clientId/properties', async (req, res) => {
  try {
    const { clientId } = req.params;
    const propertyData = req.body;
    
    // Validate client exists
    const { rows: clientRows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    
    if (clientRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }
    
    await db.query('BEGIN');
    
    try {
      // Convert camelCase to snake_case
      const dbData = camelToSnake(propertyData);
      const propertyId = uuidv4();
      dbData.id = propertyId;
      dbData.client_id = clientId;
      
      // Handle isPrimary logic
      if (dbData.is_primary === true) {
        // Unset any existing primary property for this client
        await db.query(
          'UPDATE properties SET is_primary = false WHERE client_id = $1 AND deleted_at IS NULL',
          [clientId]
        );
      }
      
      // Build insert query - filter out undefined values and ensure we have at least some data
      const columns = Object.keys(dbData).filter(k => k !== 'id' && dbData[k] !== undefined);
      
      if (columns.length === 0) {
        await db.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'No valid property data provided'
        });
      }
      
      const values = columns.map(k => dbData[k]);
      const placeholders = columns.map((_, i) => `$${i + 2}`).join(', ');
      
      const insertQuery = `
        INSERT INTO properties (id, ${columns.join(', ')}) 
        VALUES ($1, ${placeholders}) 
        RETURNING *
      `;
      
      const { rows: propertyRows } = await db.query(insertQuery, [propertyId, ...values]);
      
      await db.query('COMMIT');
      
      const response = snakeToCamel(propertyRows[0]);
      res.status(201).json({ success: true, data: response });
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/properties/:id - Get property details
apiRouter.get('/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get property
    const { rows: propertyRows } = await db.query(
      'SELECT * FROM properties WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (propertyRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Property not found' 
      });
    }
    
    const property = snakeToCamel(propertyRows[0]);
    
    // Get client information
    const { rows: clientRows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [propertyRows[0].client_id]
    );
    
    if (clientRows.length > 0) {
      property.client = snakeToCamel(clientRows[0]);
    }
    
    // Get contacts linked to this property
    const { rows: contactRows } = await db.query(
      'SELECT * FROM contacts WHERE property_id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    const contacts = [];
    for (const contact of contactRows) {
      const transformedContact = snakeToCamel(contact);
      
      // Get channels for this contact
      const { rows: channelRows } = await db.query(
        'SELECT * FROM contact_channels WHERE contact_id = $1',
        [contact.id]
      );
      transformedContact.channels = channelRows.map(snakeToCamel);
      
      contacts.push(transformedContact);
    }
    property.contacts = contacts;
    
    res.json({ success: true, data: property });
    
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/properties/:id - Update property
apiRouter.put('/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const propertyData = req.body;
    
    // Check if property exists
    const { rows: existingRows } = await db.query(
      'SELECT * FROM properties WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (existingRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Property not found' 
      });
    }
    
    await db.query('BEGIN');
    
    try {
      const existingProperty = existingRows[0];
      
      // Handle isPrimary logic
      if (propertyData.isPrimary === true) {
        // Unset other primary properties for this client
        await db.query(
          'UPDATE properties SET is_primary = false WHERE client_id = $1 AND id != $2 AND deleted_at IS NULL',
          [existingProperty.client_id, id]
        );
      }
      
      // Convert to snake_case and remove fields that shouldn't be updated
      const dbData = camelToSnake(propertyData);
      delete dbData.id;
      delete dbData.client_id;
      delete dbData.created_at;
      delete dbData.deleted_at;
      delete dbData.client;
      delete dbData.contacts;
      
      // Build update query
      const columns = Object.keys(dbData);
      const values = columns.map(k => dbData[k]);
      const setString = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
      
      const updateQuery = `
        UPDATE properties 
        SET ${setString}, updated_at = NOW() 
        WHERE id = $1 
        RETURNING *
      `;
      
      const { rows: updatedRows } = await db.query(updateQuery, [id, ...values]);
      
      await db.query('COMMIT');
      
      const response = snakeToCamel(updatedRows[0]);
      res.json({ success: true, data: response });
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/properties/:id - Soft delete property
apiRouter.delete('/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if property exists
    const { rows: propertyRows } = await db.query(
      'SELECT * FROM properties WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (propertyRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Property not found' 
      });
    }
    
    const property = propertyRows[0];
    
    // Check if this is the only property for the client
    const { rows: clientPropertyRows } = await db.query(
      'SELECT COUNT(*) as count FROM properties WHERE client_id = $1 AND deleted_at IS NULL',
      [property.client_id]
    );
    
    if (parseInt(clientPropertyRows[0].count) <= 1) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete the only property for a client' 
      });
    }
    
    // Check if property is linked to any jobs (via property address matching)
    // Note: This is a simplified check. In production, you'd want a proper FK relationship
    const propertyAddress = `${property.address_line1}, ${property.city}, ${property.state}`;
    const { rows: jobRows } = await db.query(
      'SELECT COUNT(*) as count FROM jobs WHERE job_location ILIKE $1',
      [`%${property.address_line1}%`]
    );
    
    if (parseInt(jobRows[0].count) > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete property that is linked to existing jobs' 
      });
    }
    
    // Soft delete property
    await db.query(
      'UPDATE properties SET deleted_at = NOW() WHERE id = $1',
      [id]
    );
    
    res.status(204).send();
    
  } catch (err) {
    handleError(res, err);
  }
});


// ============================================================================
// TAG MANAGEMENT API ENDPOINTS
// ============================================================================

// Helper function: Calculate usage count for a tag
const calculateTagUsageCount = async (tagId) => {
  try {
    const { rows } = await db.query(
      'SELECT COUNT(*) as count FROM entity_tags WHERE tag_id = $1',
      [tagId]
    );
    return parseInt(rows[0]?.count || 0);
  } catch (err) {
    console.error('Error calculating tag usage count:', err);
    return 0;
  }
};

// Helper function: Get or create tag by name
const getOrCreateTagByName = async (name, category = null) => {
  try {
    const { rows: existingTags } = await db.query(
      'SELECT * FROM tags WHERE LOWER(name) = LOWER($1)',
      [name]
    );
    
    if (existingTags.length > 0) {
      return snakeToCamel(existingTags[0]);
    }
    
    const tagId = uuidv4();
    const { rows: newTagRows } = await db.query(
      `INSERT INTO tags (id, name, color, category) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [tagId, name, '#00c2ff', category]
    );
    
    return snakeToCamel(newTagRows[0]);
  } catch (err) {
    console.error('Error in getOrCreateTagByName:', err);
    throw err;
  }
};

// Helper function: Validate entity type
const validateEntityType = (entityType) => {
  const validTypes = ['client', 'property', 'quote', 'job', 'lead'];
  return validTypes.includes(entityType);
};

// Helper function: Get table name for entity type
const getTableNameForEntityType = (entityType) => {
  const tableMap = {
    'client': 'clients',
    'property': 'properties',
    'quote': 'quotes',
    'job': 'jobs',
    'lead': 'leads'
  };
  return tableMap[entityType];
};

// Helper function: Validate entity exists
const validateEntityExists = async (entityType, entityId) => {
  const tableName = getTableNameForEntityType(entityType);
  if (!tableName) return false;
  
  try {
    const { rows } = await db.query(
      `SELECT id FROM ${tableName} WHERE id = $1`,
      [entityId]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('Error validating entity existence:', err);
    return false;
  }
};

// GET /api/tags - List all tags
apiRouter.get('/tags', async (req, res) => {
  try {
    const { category } = req.query;
    
    let queryText = `
      SELECT t.*, 
             (SELECT COUNT(*) FROM entity_tags et WHERE et.tag_id = t.id) as usage_count
      FROM tags t
    `;
    
    const queryParams = [];
    
    if (category) {
      queryText += ' WHERE t.category = $1';
      queryParams.push(category);
    }
    
    queryText += ' ORDER BY t.name ASC';
    
    const { rows } = await db.query(queryText, queryParams);
    
    const tags = rows.map(row => ({
      ...snakeToCamel(row),
      usageCount: parseInt(row.usage_count || 0)
    }));
    
    res.json({ success: true, data: tags });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/tags - Create new tag
apiRouter.post('/tags', async (req, res) => {
  try {
    const { name, color = '#00c2ff', description, category } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        error: 'Tag name is required' 
      });
    }
    
    const { rows: existingTags } = await db.query(
      'SELECT * FROM tags WHERE LOWER(name) = LOWER($1)',
      [name.trim()]
    );
    
    if (existingTags.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Tag name must be unique (case-insensitive)' 
      });
    }
    
    const tagId = uuidv4();
    const { rows: newTagRows } = await db.query(
      `INSERT INTO tags (id, name, color, description, category) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [tagId, name.trim(), color, description || null, category || null]
    );
    
    const tag = snakeToCamel(newTagRows[0]);
    tag.usageCount = 0;
    
    res.status(201).json({ success: true, data: tag });
    
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/tags/:id - Update tag
apiRouter.put('/tags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, description, category } = req.body;
    
    const { rows: existingTagRows } = await db.query(
      'SELECT * FROM tags WHERE id = $1',
      [id]
    );
    
    if (existingTagRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Tag not found' 
      });
    }
    
    if (name && name.trim() !== '') {
      const { rows: duplicateTagRows } = await db.query(
        'SELECT * FROM tags WHERE LOWER(name) = LOWER($1) AND id != $2',
        [name.trim(), id]
      );
      
      if (duplicateTagRows.length > 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Tag name must be unique (case-insensitive)' 
        });
      }
    }
    
    const updates = [];
    const values = [id];
    let paramIndex = 2;
    
    if (name !== undefined && name.trim() !== '') {
      updates.push(`name = $${paramIndex}`);
      values.push(name.trim());
      paramIndex++;
    }
    
    if (color !== undefined) {
      updates.push(`color = $${paramIndex}`);
      values.push(color);
      paramIndex++;
    }
    
    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      values.push(description);
      paramIndex++;
    }
    
    if (category !== undefined) {
      updates.push(`category = $${paramIndex}`);
      values.push(category);
      paramIndex++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No valid fields to update' 
      });
    }
    
    const queryText = `
      UPDATE tags 
      SET ${updates.join(', ')} 
      WHERE id = $1 
      RETURNING *
    `;
    
    const { rows: updatedTagRows } = await db.query(queryText, values);
    
    const tag = snakeToCamel(updatedTagRows[0]);
    tag.usageCount = await calculateTagUsageCount(id);
    
    res.json({ success: true, data: tag });
    
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/tags/:id - Delete tag
apiRouter.delete('/tags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows: existingTagRows } = await db.query(
      'SELECT * FROM tags WHERE id = $1',
      [id]
    );
    
    if (existingTagRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Tag not found' 
      });
    }
    
    await db.query('DELETE FROM entity_tags WHERE tag_id = $1', [id]);
    
    await db.query('DELETE FROM tags WHERE id = $1', [id]);
    
    res.status(204).send();
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// ENTITY TAGGING API ENDPOINTS
// ============================================================================

// POST /api/entities/:entityType/:entityId/tags - Add tags to entity
apiRouter.post('/entities/:entityType/:entityId/tags', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const { tagIds, tagNames } = req.body;
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    const entityExists = await validateEntityExists(entityType, entityId);
    if (!entityExists) {
      return res.status(404).json({ 
        success: false, 
        error: `${entityType} not found` 
      });
    }
    
    const tagsToAdd = [];
    
    if (tagIds && Array.isArray(tagIds) && tagIds.length > 0) {
      for (const tagId of tagIds) {
        const { rows: tagRows } = await db.query(
          'SELECT * FROM tags WHERE id = $1',
          [tagId]
        );
        
        if (tagRows.length > 0) {
          tagsToAdd.push(tagRows[0]);
        }
      }
    }
    
    if (tagNames && Array.isArray(tagNames) && tagNames.length > 0) {
      for (const tagName of tagNames) {
        if (tagName && tagName.trim() !== '') {
          const tag = await getOrCreateTagByName(tagName.trim(), entityType);
          const tagSnake = camelToSnake(tag);
          tagsToAdd.push(tagSnake);
        }
      }
    }
    
    for (const tag of tagsToAdd) {
      const entityTagId = uuidv4();
      await db.query(
        `INSERT INTO entity_tags (id, tag_id, entity_type, entity_id, tagged_by) 
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT unique_entity_tag DO NOTHING`,
        [entityTagId, tag.id, entityType, entityId, 'system']
      );
    }
    
    const { rows: allEntityTagRows } = await db.query(
      `SELECT t.* 
       FROM tags t
       INNER JOIN entity_tags et ON et.tag_id = t.id
       WHERE et.entity_type = $1 AND et.entity_id = $2
       ORDER BY t.name ASC`,
      [entityType, entityId]
    );
    
    const tags = allEntityTagRows.map(row => snakeToCamel(row));
    
    res.json({ success: true, data: tags });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/entities/:entityType/:entityId/tags - Get tags for entity
apiRouter.get('/entities/:entityType/:entityId/tags', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    const entityExists = await validateEntityExists(entityType, entityId);
    if (!entityExists) {
      return res.status(404).json({ 
        success: false, 
        error: `${entityType} not found` 
      });
    }
    
    const { rows: tagRows } = await db.query(
      `SELECT t.* 
       FROM tags t
       INNER JOIN entity_tags et ON et.tag_id = t.id
       WHERE et.entity_type = $1 AND et.entity_id = $2
       ORDER BY t.name ASC`,
      [entityType, entityId]
    );
    
    const tags = tagRows.map(row => snakeToCamel(row));
    
    res.json({ success: true, data: tags });
    
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/entities/:entityType/:entityId/tags/:tagId - Remove tag from entity
apiRouter.delete('/entities/:entityType/:entityId/tags/:tagId', async (req, res) => {
  try {
    const { entityType, entityId, tagId } = req.params;
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    const entityExists = await validateEntityExists(entityType, entityId);
    if (!entityExists) {
      return res.status(404).json({ 
        success: false, 
        error: `${entityType} not found` 
      });
    }
    
    const { rows: entityTagRows } = await db.query(
      `SELECT * FROM entity_tags 
       WHERE tag_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [tagId, entityType, entityId]
    );
    
    if (entityTagRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Tag association not found' 
      });
    }
    
    await db.query(
      `DELETE FROM entity_tags 
       WHERE tag_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [tagId, entityType, entityId]
    );
    
    res.status(204).send();
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// CUSTOM FIELDS MANAGEMENT API ENDPOINTS
// ============================================================================

// Helper function: Validate field type
const validateFieldType = (fieldType) => {
  const validTypes = ['text', 'number', 'date', 'dropdown', 'checkbox', 'textarea'];
  return validTypes.includes(fieldType);
};

// Helper function: Generate field name from label
const generateFieldName = (label) => {
  if (!label) return '';
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_');
};

// Helper function: Apply validation rules
const applyValidationRules = (value, rules, fieldType) => {
  if (!rules || typeof rules !== 'object') {
    return { valid: true };
  }

  if (fieldType === 'number') {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      return { valid: false, error: 'Value must be a valid number' };
    }
    
    if (rules.min !== undefined && numValue < rules.min) {
      return { valid: false, error: `Value must be at least ${rules.min}` };
    }
    
    if (rules.max !== undefined && numValue > rules.max) {
      return { valid: false, error: `Value must be at most ${rules.max}` };
    }
  }

  if (fieldType === 'text' || fieldType === 'textarea') {
    if (rules.pattern) {
      try {
        const regex = new RegExp(rules.pattern);
        if (!regex.test(value)) {
          return { valid: false, error: `Value does not match required pattern` };
        }
      } catch (err) {
        console.error('Invalid regex pattern:', err);
      }
    }
    
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      return { valid: false, error: `Value must be at least ${rules.minLength} characters` };
    }
    
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      return { valid: false, error: `Value must be at most ${rules.maxLength} characters` };
    }
  }

  return { valid: true };
};

// Helper function: Validate field value against field definition
const validateFieldValue = (value, fieldDefinition) => {
  if (!value && fieldDefinition.is_required) {
    return { valid: false, error: `${fieldDefinition.field_label} is required` };
  }

  if (!value) {
    return { valid: true };
  }

  const fieldType = fieldDefinition.field_type;

  if (fieldType === 'date') {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return { valid: false, error: 'Invalid date format' };
    }
  }

  if (fieldType === 'checkbox') {
    if (value !== 'true' && value !== 'false') {
      return { valid: false, error: 'Checkbox value must be true or false' };
    }
  }

  if (fieldType === 'dropdown') {
    const options = fieldDefinition.options || [];
    if (!options.includes(value)) {
      return { valid: false, error: `Value must be one of: ${options.join(', ')}` };
    }
  }

  if (fieldDefinition.validation_rules) {
    return applyValidationRules(value, fieldDefinition.validation_rules, fieldType);
  }

  return { valid: true };
};

// GET /api/custom-fields/:entityType - Get field definitions for entity type
apiRouter.get('/custom-fields/:entityType', async (req, res) => {
  try {
    const { entityType } = req.params;
    const { includeInactive } = req.query;
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    let queryText = `
      SELECT * FROM custom_field_definitions 
      WHERE entity_type = $1
    `;
    
    if (includeInactive !== 'true') {
      queryText += ' AND is_active = true';
    }
    
    queryText += ' ORDER BY display_order ASC, field_label ASC';
    
    const { rows } = await db.query(queryText, [entityType]);
    
    const fieldDefinitions = rows.map(row => snakeToCamel(row));
    
    res.json({ success: true, data: fieldDefinitions });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/custom-fields - Create new field definition
apiRouter.post('/custom-fields', async (req, res) => {
  try {
    const { 
      entityType, 
      fieldName, 
      fieldLabel, 
      fieldType, 
      isRequired = false, 
      defaultValue, 
      options, 
      validationRules, 
      displayOrder = 0, 
      helpText 
    } = req.body;
    
    if (!entityType || !fieldLabel || !fieldType) {
      return res.status(400).json({ 
        success: false, 
        error: 'entityType, fieldLabel, and fieldType are required' 
      });
    }
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    if (!validateFieldType(fieldType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid field type. Must be one of: text, number, date, dropdown, checkbox, textarea` 
      });
    }
    
    const finalFieldName = fieldName || generateFieldName(fieldLabel);
    
    if (!finalFieldName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid field name generated from label' 
      });
    }
    
    const { rows: existingFields } = await db.query(
      'SELECT * FROM custom_field_definitions WHERE entity_type = $1 AND LOWER(field_name) = LOWER($2)',
      [entityType, finalFieldName]
    );
    
    if (existingFields.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Field name must be unique for this entity type (case-insensitive)' 
      });
    }
    
    if (fieldType === 'dropdown') {
      if (!options || !Array.isArray(options) || options.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Dropdown fields must have options array' 
        });
      }
    }
    
    const fieldId = uuidv4();
    const { rows: newFieldRows } = await db.query(
      `INSERT INTO custom_field_definitions (
        id, entity_type, field_name, field_label, field_type, 
        is_required, default_value, options, validation_rules, 
        display_order, help_text, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
      RETURNING *`,
      [
        fieldId, 
        entityType, 
        finalFieldName, 
        fieldLabel, 
        fieldType, 
        isRequired, 
        defaultValue || null, 
        options ? JSON.stringify(options) : null, 
        validationRules ? JSON.stringify(validationRules) : null, 
        displayOrder, 
        helpText || null, 
        true
      ]
    );
    
    const fieldDefinition = snakeToCamel(newFieldRows[0]);
    
    res.status(201).json({ success: true, data: fieldDefinition });
    
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/custom-fields/:id - Update field definition
apiRouter.put('/custom-fields/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      fieldLabel, 
      fieldType, 
      isRequired, 
      defaultValue, 
      options, 
      validationRules, 
      displayOrder, 
      helpText,
      isActive
    } = req.body;
    
    const { rows: existingFieldRows } = await db.query(
      'SELECT * FROM custom_field_definitions WHERE id = $1',
      [id]
    );
    
    if (existingFieldRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Field definition not found' 
      });
    }
    
    if (fieldType !== undefined && !validateFieldType(fieldType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid field type. Must be one of: text, number, date, dropdown, checkbox, textarea` 
      });
    }
    
    if (fieldType === 'dropdown' && options) {
      if (!Array.isArray(options) || options.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Dropdown fields must have options array' 
        });
      }
    }
    
    const updates = [];
    const values = [id];
    let paramIndex = 2;
    
    if (fieldLabel !== undefined) {
      updates.push(`field_label = $${paramIndex}`);
      values.push(fieldLabel);
      paramIndex++;
    }
    
    if (fieldType !== undefined) {
      updates.push(`field_type = $${paramIndex}`);
      values.push(fieldType);
      paramIndex++;
    }
    
    if (isRequired !== undefined) {
      updates.push(`is_required = $${paramIndex}`);
      values.push(isRequired);
      paramIndex++;
    }
    
    if (defaultValue !== undefined) {
      updates.push(`default_value = $${paramIndex}`);
      values.push(defaultValue);
      paramIndex++;
    }
    
    if (options !== undefined) {
      updates.push(`options = $${paramIndex}`);
      values.push(options ? JSON.stringify(options) : null);
      paramIndex++;
    }
    
    if (validationRules !== undefined) {
      updates.push(`validation_rules = $${paramIndex}`);
      values.push(validationRules ? JSON.stringify(validationRules) : null);
      paramIndex++;
    }
    
    if (displayOrder !== undefined) {
      updates.push(`display_order = $${paramIndex}`);
      values.push(displayOrder);
      paramIndex++;
    }
    
    if (helpText !== undefined) {
      updates.push(`help_text = $${paramIndex}`);
      values.push(helpText);
      paramIndex++;
    }
    
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      values.push(isActive);
      paramIndex++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No fields to update' 
      });
    }
    
    updates.push(`updated_at = NOW()`);
    
    const queryText = `
      UPDATE custom_field_definitions 
      SET ${updates.join(', ')} 
      WHERE id = $1 
      RETURNING *
    `;
    
    const { rows: updatedFieldRows } = await db.query(queryText, values);
    
    const fieldDefinition = snakeToCamel(updatedFieldRows[0]);
    
    res.json({ success: true, data: fieldDefinition });
    
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/custom-fields/:id - Soft delete field definition
apiRouter.delete('/custom-fields/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows: existingFieldRows } = await db.query(
      'SELECT * FROM custom_field_definitions WHERE id = $1',
      [id]
    );
    
    if (existingFieldRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Field definition not found' 
      });
    }
    
    await db.query(
      'UPDATE custom_field_definitions SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    
    res.status(204).send();
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// CUSTOM FIELD VALUES API ENDPOINTS
// ============================================================================

// POST /api/entities/:entityType/:entityId/custom-fields - Set custom field values
apiRouter.post('/entities/:entityType/:entityId/custom-fields', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const { fieldValues } = req.body;
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    const entityExists = await validateEntityExists(entityType, entityId);
    if (!entityExists) {
      return res.status(404).json({ 
        success: false, 
        error: `${entityType} not found` 
      });
    }
    
    if (!fieldValues || typeof fieldValues !== 'object') {
      return res.status(400).json({ 
        success: false, 
        error: 'fieldValues object is required' 
      });
    }
    
    const { rows: fieldDefinitions } = await db.query(
      'SELECT * FROM custom_field_definitions WHERE entity_type = $1 AND is_active = true',
      [entityType]
    );
    
    const fieldDefMap = {};
    fieldDefinitions.forEach(fd => {
      fieldDefMap[fd.field_name.toLowerCase()] = fd;
    });
    
    for (const fieldName of Object.keys(fieldValues)) {
      const fieldDef = fieldDefMap[fieldName.toLowerCase()];
      if (!fieldDef) {
        return res.status(400).json({ 
          success: false, 
          error: `Unknown field: ${fieldName}` 
        });
      }
      
      const validation = validateFieldValue(fieldValues[fieldName], fieldDef);
      if (!validation.valid) {
        return res.status(400).json({ 
          success: false, 
          error: validation.error 
        });
      }
    }
    
    for (const fieldDef of fieldDefinitions) {
      if (fieldDef.is_required) {
        const fieldValue = fieldValues[fieldDef.field_name];
        if (!fieldValue) {
          return res.status(400).json({ 
            success: false, 
            error: `Required field missing: ${fieldDef.field_label}` 
          });
        }
      }
    }
    
    const savedValues = {};
    
    for (const [fieldName, fieldValue] of Object.entries(fieldValues)) {
      const fieldDef = fieldDefMap[fieldName.toLowerCase()];
      
      if (fieldValue !== null && fieldValue !== undefined && fieldValue !== '') {
        await db.query(
          `INSERT INTO custom_field_values (id, field_definition_id, entity_type, entity_id, field_value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (field_definition_id, entity_type, entity_id) 
           DO UPDATE SET field_value = $5, updated_at = NOW()`,
          [uuidv4(), fieldDef.id, entityType, entityId, String(fieldValue)]
        );
        savedValues[fieldName] = fieldValue;
      }
    }
    
    res.json({ success: true, data: savedValues });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/entities/:entityType/:entityId/custom-fields - Get custom field values
apiRouter.get('/entities/:entityType/:entityId/custom-fields', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    const entityExists = await validateEntityExists(entityType, entityId);
    if (!entityExists) {
      return res.status(404).json({ 
        success: false, 
        error: `${entityType} not found` 
      });
    }
    
    const { rows } = await db.query(
      `SELECT 
        cfd.*,
        cfv.field_value,
        cfv.id as value_id
       FROM custom_field_definitions cfd
       LEFT JOIN custom_field_values cfv 
         ON cfv.field_definition_id = cfd.id 
         AND cfv.entity_type = $1 
         AND cfv.entity_id = $2
       WHERE cfd.entity_type = $1 
         AND cfd.is_active = true
       ORDER BY cfd.display_order ASC, cfd.field_label ASC`,
      [entityType, entityId]
    );
    
    const customFields = rows.map(row => ({
      definition: snakeToCamel({
        id: row.id,
        entityType: row.entity_type,
        fieldName: row.field_name,
        fieldLabel: row.field_label,
        fieldType: row.field_type,
        isRequired: row.is_required,
        defaultValue: row.default_value,
        options: row.options,
        validationRules: row.validation_rules,
        displayOrder: row.display_order,
        helpText: row.help_text,
        isActive: row.is_active
      }),
      value: row.field_value || null,
      valueId: row.value_id || null
    }));
    
    res.json({ success: true, data: customFields });
    
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/entities/:entityType/:entityId/custom-fields/:fieldDefinitionId - Clear custom field value
apiRouter.delete('/entities/:entityType/:entityId/custom-fields/:fieldDefinitionId', async (req, res) => {
  try {
    const { entityType, entityId, fieldDefinitionId } = req.params;
    
    if (!validateEntityType(entityType)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid entity type. Must be one of: client, property, quote, job, lead` 
      });
    }
    
    const entityExists = await validateEntityExists(entityType, entityId);
    if (!entityExists) {
      return res.status(404).json({ 
        success: false, 
        error: `${entityType} not found` 
      });
    }
    
    const { rows: fieldValueRows } = await db.query(
      `SELECT * FROM custom_field_values 
       WHERE field_definition_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [fieldDefinitionId, entityType, entityId]
    );
    
    if (fieldValueRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Custom field value not found' 
      });
    }
    
    await db.query(
      `DELETE FROM custom_field_values 
       WHERE field_definition_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [fieldDefinitionId, entityType, entityId]
    );
    
    res.status(204).send();
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// QUOTE MANAGEMENT - HELPER FUNCTIONS
// ============================================================================

// Helper: Calculate quote totals (subtotal → discount → tax → grand total)
const calculateQuoteTotals = (lineItems, discountPercentage = 0, discountAmount = 0, taxRate = 0) => {
  const subtotal = lineItems.reduce((sum, item) => {
    // Support both old format (quantity * unitPrice) and new format (price)
    const itemTotal = item.price !== undefined 
      ? (item.price || 0) 
      : ((item.quantity || 0) * (item.unitPrice || 0));
    return sum + itemTotal;
  }, 0);
  
  let finalDiscountAmount = discountAmount;
  if (discountPercentage > 0) {
    finalDiscountAmount = (subtotal * discountPercentage) / 100;
  }
  
  const afterDiscount = subtotal - finalDiscountAmount;
  const taxAmount = (afterDiscount * taxRate) / 100;
  const grandTotal = afterDiscount + taxAmount;
  
  return {
    totalAmount: parseFloat(subtotal.toFixed(2)),
    discountAmount: parseFloat(finalDiscountAmount.toFixed(2)),
    taxAmount: parseFloat(taxAmount.toFixed(2)),
    grandTotal: parseFloat(grandTotal.toFixed(2))
  };
};

// Helper: Generate quote number (Q-YYYYMM-####)
const generateQuoteNumber = async () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `Q-${year}${month}`;
  
  const { rows } = await db.query(
    `SELECT quote_number FROM quotes 
     WHERE quote_number LIKE $1 
     ORDER BY quote_number DESC LIMIT 1`,
    [`${prefix}-%`]
  );
  
  let nextNumber = 1;
  if (rows.length > 0 && rows[0].quote_number) {
    const lastNumber = parseInt(rows[0].quote_number.split('-')[2]);
    nextNumber = lastNumber + 1;
  }

  return `${prefix}-${String(nextNumber).padStart(4, '0')}`;
};

// ============================================================================
// ENHANCED QUOTE ENDPOINTS
// ============================================================================

// POST /api/quotes - Create new quote with enhanced CRM features
apiRouter.post('/quotes', async (req, res) => {
  try {
    const quoteData = req.body;
    
    await db.query('BEGIN');
    
    try {
      const quoteId = uuidv4();
      const quoteNumber = await generateQuoteNumber();

      // Sanitize UUID fields early to prevent "undefined" strings
      const sanitizedClientId = sanitizeUUID(quoteData.clientId);
      const sanitizedPropertyId = sanitizeUUID(quoteData.propertyId);
      const sanitizedLeadId = sanitizeUUID(quoteData.leadId);

      let associatedClientId = sanitizedClientId;
      let ensuredClient;

      if (quoteData.customerDetails) {
        try {
          const ensured = await ensureClientAssociation({
            clientId: sanitizedClientId,
            customerDetails: quoteData.customerDetails
          });
          associatedClientId = ensured.clientId;
          ensuredClient = ensured.client;
        } catch (clientErr) {
          await db.query('ROLLBACK');
          return res.status(400).json({ success: false, error: clientErr.message });
        }
      } else if (!associatedClientId) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Client information is required to create a quote' });
      }

      delete quoteData.customerDetails;

      const lineItems = quoteData.lineItems || [];
      const discountPercentage = quoteData.discountPercentage || 0;
      const discountAmount = quoteData.discountAmount || 0;
      const taxRate = quoteData.taxRate || 0;
      
      const totals = calculateQuoteTotals(lineItems, discountPercentage, discountAmount, taxRate);
      
      let customerName = quoteData.customerName || 'Unknown';
      let clientRecord = ensuredClient;
      if (!clientRecord && associatedClientId) {
        const { rows: fallbackRows } = await db.query(
          'SELECT company_name, first_name, last_name FROM clients WHERE id = $1',
          [associatedClientId]
        );
        clientRecord = fallbackRows[0];
      }

      if (clientRecord) {
        customerName = clientRecord.company_name || `${clientRecord.first_name || ''} ${clientRecord.last_name || ''}`.trim() || 'Unknown';
      }
      
      const insertQuery = `
        INSERT INTO quotes (
          id, client_id, property_id, lead_id, customer_name, quote_number, version,
          approval_status, line_items, total_amount, discount_amount,
          discount_percentage, tax_rate, tax_amount, grand_total,
          terms_and_conditions, internal_notes, status, valid_until,
          deposit_amount, payment_terms, special_instructions, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 1, 'pending', $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, NOW()
        ) RETURNING *
      `;
      
      const { rows: quoteRows } = await db.query(insertQuery, [
        quoteId,
        associatedClientId,
        sanitizedPropertyId,
        sanitizedLeadId,
        customerName,
        quoteNumber,
        JSON.stringify(lineItems),
        totals.totalAmount,
        totals.discountAmount,
        discountPercentage,
        taxRate,
        totals.taxAmount,
        totals.grandTotal,
        quoteData.termsAndConditions || null,
        quoteData.internalNotes || null,
        quoteData.status || 'Draft',
        quoteData.validUntil || null,
        quoteData.depositAmount || null,
        quoteData.paymentTerms || 'Net 30',
        quoteData.specialInstructions || null
      ]);
      
      const versionId = uuidv4();
      await db.query(
        `INSERT INTO quote_versions (
          id, quote_id, version_number, line_items, total_amount,
          terms, notes, changed_by, change_reason, created_at
        ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          versionId,
          quoteId,
          JSON.stringify(lineItems),
          totals.grandTotal,
          quoteData.termsAndConditions || null,
          'Initial version',
          quoteData.createdBy || 'system',
          'Quote created'
        ]
      );
      
      await db.query('COMMIT');
      
      const quote = snakeToCamel(quoteRows[0]);
      res.status(201).json({ success: true, data: quote });
      
      reindexDocument('quotes', quoteRows[0]);
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/quotes - List quotes with filtering and pagination
apiRouter.get('/quotes', async (req, res) => {
  try {
    const { clientId, propertyId, approvalStatus, status, page = 1, limit = 50 } = req.query;
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let queryText = `
      SELECT 
        q.*,
        c.first_name as client_first_name,
        c.last_name as client_last_name,
        c.company_name as client_company_name,
        c.primary_email as client_email,
        c.primary_phone as client_phone,
        p.property_name,
        p.address_line1 as property_address,
        p.city as property_city,
        p.state as property_state
      FROM quotes q
      LEFT JOIN clients c ON q.client_id = c.id
      LEFT JOIN properties p ON q.property_id = p.id
      WHERE q.deleted_at IS NULL
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (clientId) {
      queryText += ` AND q.client_id = $${paramIndex}`;
      params.push(clientId);
      paramIndex++;
    }
    
    if (propertyId) {
      queryText += ` AND q.property_id = $${paramIndex}`;
      params.push(propertyId);
      paramIndex++;
    }
    
    if (approvalStatus) {
      queryText += ` AND q.approval_status = $${paramIndex}`;
      params.push(approvalStatus);
      paramIndex++;
    }
    
    if (status) {
      queryText += ` AND q.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    queryText += ` ORDER BY q.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), offset);
    
    const { rows } = await db.query(queryText, params);
    
    const quotes = rows.map(row => {
      const quote = snakeToCamel(row);
      
      if (row.client_first_name || row.client_last_name || row.client_company_name) {
        quote.client = {
          firstName: row.client_first_name,
          lastName: row.client_last_name,
          companyName: row.client_company_name,
          email: row.client_email,
          phone: row.client_phone
        };
      }
      
      if (row.property_name || row.property_address) {
        quote.property = {
          propertyName: row.property_name,
          address: row.property_address,
          city: row.property_city,
          state: row.property_state
        };
      }
      
      delete quote.clientFirstName;
      delete quote.clientLastName;
      delete quote.clientCompanyName;
      delete quote.clientEmail;
      delete quote.clientPhone;
      delete quote.propertyName;
      delete quote.propertyAddress;
      delete quote.propertyCity;
      delete quote.propertyState;
      
      return quote;
    });
    
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) FROM quotes WHERE deleted_at IS NULL'
    );
    const total = parseInt(countRows[0].count);
    
    res.json({
      success: true,
      data: quotes,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/quotes/:id - Get quote details with full relationships
apiRouter.get('/quotes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeUUID(id);
    
    if (!sanitizedId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid quote ID'
      });
    }
    
    const { rows: quoteRows } = await db.query(
      'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [sanitizedId]
    );
    
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const quote = snakeToCamel(quoteRows[0]);
    
    // Sanitize UUID fields to prevent "undefined" strings from being passed to queries
    const sanitizedClientId = sanitizeUUID(quote.clientId);
    const sanitizedPropertyId = sanitizeUUID(quote.propertyId);
    
    if (sanitizedClientId) {
      const { rows: clientRows } = await db.query(
        'SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL',
        [sanitizedClientId]
      );
      if (clientRows.length > 0) {
        quote.client = snakeToCamel(clientRows[0]);
      }
    }
    
    if (sanitizedPropertyId) {
      const { rows: propertyRows } = await db.query(
        'SELECT * FROM properties WHERE id = $1 AND deleted_at IS NULL',
        [sanitizedPropertyId]
      );
      if (propertyRows.length > 0) {
        quote.property = snakeToCamel(propertyRows[0]);
      }
    }
    
    const { rows: versionRows } = await db.query(
      'SELECT * FROM quote_versions WHERE quote_id = $1 ORDER BY version_number DESC',
      [sanitizedId]
    );
    quote.versions = versionRows.map(snakeToCamel);
    
    const { rows: followupRows } = await db.query(
      'SELECT * FROM quote_followups WHERE quote_id = $1 ORDER BY scheduled_date ASC',
      [sanitizedId]
    );
    quote.followups = followupRows.map(snakeToCamel);
    
    const { rows: tagRows} = await db.query(
      `SELECT t.* FROM tags t
       INNER JOIN entity_tags et ON et.tag_id = t.id
       WHERE et.entity_type = 'quote' AND et.entity_id = $1`,
      [sanitizedId]
    );
    quote.tags = tagRows.map(snakeToCamel);
    
    res.json({ success: true, data: quote });
    
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/quotes/:id - Update quote
apiRouter.put('/quotes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeUUID(id);
    
    if (!sanitizedId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid quote ID'
      });
    }
    
    const quoteData = req.body;

    const { rows: existingRows } = await db.query(
      'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [sanitizedId]
    );
    
    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const existingQuote = existingRows[0];
    const updates = [];
    const values = [sanitizedId];
    let paramIndex = 2;

    const sanitizedClientId = sanitizeUUID(quoteData.clientId) || existingQuote.client_id;
    const sanitizedPropertyId = sanitizeUUID(quoteData.propertyId) || existingQuote.property_id;
    const sanitizedLeadId = sanitizeUUID(quoteData.leadId) || existingQuote.lead_id;
    let associatedClientId = sanitizedClientId;
    let clientRecord = null;

    if (quoteData.customerDetails) {
      try {
        const ensured = await ensureClientAssociation({
          clientId: sanitizedClientId,
          customerDetails: quoteData.customerDetails
        });
        associatedClientId = ensured.clientId;
        clientRecord = ensured.client;
      } catch (clientErr) {
        return res.status(400).json({ success: false, error: clientErr.message });
      }
    }

    delete quoteData.customerDetails;

    if (associatedClientId && associatedClientId !== existingQuote.client_id) {
      updates.push(`client_id = $${paramIndex}`);
      values.push(associatedClientId);
      paramIndex++;
    }

    if (sanitizedPropertyId && sanitizedPropertyId !== existingQuote.property_id) {
      updates.push(`property_id = $${paramIndex}`);
      values.push(sanitizedPropertyId);
      paramIndex++;
    }

    if (sanitizedLeadId && sanitizedLeadId !== existingQuote.lead_id) {
      updates.push(`lead_id = $${paramIndex}`);
      values.push(sanitizedLeadId);
      paramIndex++;
    }

    if (clientRecord) {
      const computedName = clientRecord.company_name || `${clientRecord.first_name || ''} ${clientRecord.last_name || ''}`.trim() || 'Unknown';
      updates.push(`customer_name = $${paramIndex}`);
      values.push(computedName);
      paramIndex++;
    } else if (quoteData.customerName !== undefined) {
      updates.push(`customer_name = $${paramIndex}`);
      values.push(quoteData.customerName);
      paramIndex++;
    }

    if (quoteData.status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      values.push(quoteData.status);
      paramIndex++;
    }

    const parsedLineItems = quoteData.lineItems !== undefined
      ? quoteData.lineItems
      : existingQuote.line_items || [];
    const normalizedLineItems = Array.isArray(parsedLineItems)
      ? parsedLineItems
      : JSON.parse(parsedLineItems || '[]');

    const discountPercentage = quoteData.discountPercentage !== undefined
      ? quoteData.discountPercentage
      : existingQuote.discount_percentage || 0;
    const discountAmount = quoteData.discountAmount !== undefined
      ? quoteData.discountAmount
      : existingQuote.discount_amount || 0;
    const taxRate = quoteData.taxRate !== undefined ? quoteData.taxRate : existingQuote.tax_rate || 0;

    const totals = calculateQuoteTotals(normalizedLineItems, discountPercentage, discountAmount, taxRate);

    if (quoteData.lineItems !== undefined) {
      updates.push(`line_items = $${paramIndex}`);
      values.push(JSON.stringify(normalizedLineItems));
      paramIndex++;
    }

    if (quoteData.lineItems !== undefined || quoteData.discountPercentage !== undefined || quoteData.discountAmount !== undefined || quoteData.taxRate !== undefined) {
      updates.push(`total_amount = $${paramIndex}`);
      values.push(totals.totalAmount);
      paramIndex++;

      updates.push(`discount_amount = $${paramIndex}`);
      values.push(totals.discountAmount);
      paramIndex++;

      updates.push(`discount_percentage = $${paramIndex}`);
      values.push(discountPercentage);
      paramIndex++;

      updates.push(`tax_rate = $${paramIndex}`);
      values.push(taxRate);
      paramIndex++;

      updates.push(`tax_amount = $${paramIndex}`);
      values.push(totals.taxAmount);
      paramIndex++;

      updates.push(`grand_total = $${paramIndex}`);
      values.push(totals.grandTotal);
      paramIndex++;
    }

    if (quoteData.termsAndConditions !== undefined) {
      updates.push(`terms_and_conditions = $${paramIndex}`);
      values.push(quoteData.termsAndConditions);
      paramIndex++;
    }

    if (quoteData.internalNotes !== undefined) {
      updates.push(`internal_notes = $${paramIndex}`);
      values.push(quoteData.internalNotes);
      paramIndex++;
    }

    if (quoteData.validUntil !== undefined) {
      updates.push(`valid_until = $${paramIndex}`);
      values.push(quoteData.validUntil);
      paramIndex++;
    }

    if (quoteData.paymentTerms !== undefined) {
      updates.push(`payment_terms = $${paramIndex}`);
      values.push(quoteData.paymentTerms);
      paramIndex++;
    }

    if (quoteData.specialInstructions !== undefined) {
      updates.push(`special_instructions = $${paramIndex}`);
      values.push(quoteData.specialInstructions);
      paramIndex++;
    }

    if (quoteData.depositAmount !== undefined) {
      updates.push(`deposit_amount = $${paramIndex}`);
      values.push(quoteData.depositAmount);
      paramIndex++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }
    
    updates.push(`updated_at = NOW()`);
    
    const updateQuery = `
      UPDATE quotes
      SET ${updates.join(', ')}
      WHERE id = $1
      RETURNING *
    `;
    
    const { rows: updatedRows } = await db.query(updateQuery, values);
    const quote = snakeToCamel(updatedRows[0]);

    let automation = null;
    try {
      automation = await automationService.createJobFromApprovedQuote(sanitizedId);

      if (automation?.job) {
        reindexDocument('jobs', automation.job);
        automation.job = transformRow(automation.job, 'jobs');
      }
    } catch (automationError) {
      console.error('⚠️ Failed to auto-create job from approved quote:', automationError.message);
      automation = { status: 'error', error: automationError.message };
    }

    res.json({ success: true, data: quote, automation });
    
    reindexDocument('quotes', updatedRows[0]);
    
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/quotes/:id - Soft delete quote
apiRouter.delete('/quotes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeUUID(id);
    
    if (!sanitizedId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid quote ID'
      });
    }
    
    const { rows } = await db.query(
      'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [sanitizedId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    await db.query(
      'UPDATE quotes SET deleted_at = NOW() WHERE id = $1',
      [sanitizedId]
    );
    
    res.status(204).send();
    
    removeFromVectorStore('quotes', sanitizedId);
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quotes/:id/versions - Create new quote version
apiRouter.post('/quotes/:id/versions', async (req, res) => {
  try {
    const { id } = req.params;
    const { lineItems, changeReason, changedBy } = req.body;
    
    if (!lineItems) {
      return res.status(400).json({
        success: false,
        error: 'lineItems is required'
      });
    }
    
    await db.query('BEGIN');
    
    try {
      const { rows: quoteRows } = await db.query(
        'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );
      
      if (quoteRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Quote not found'
        });
      }
      
      const quote = quoteRows[0];
      const newVersion = quote.version + 1;
      
      const discountPercentage = quote.discount_percentage || 0;
      const discountAmount = quote.discount_amount || 0;
      const taxRate = quote.tax_rate || 0;
      
      const totals = calculateQuoteTotals(lineItems, discountPercentage, discountAmount, taxRate);
      
      await db.query(
        `UPDATE quotes
         SET version = $1, line_items = $2, total_amount = $3,
             tax_amount = $4, grand_total = $5, updated_at = NOW()
         WHERE id = $6`,
        [newVersion, JSON.stringify(lineItems), totals.totalAmount,
         totals.taxAmount, totals.grandTotal, id]
      );
      
      const versionId = uuidv4();
      await db.query(
        `INSERT INTO quote_versions (
          id, quote_id, version_number, line_items, total_amount,
          terms, notes, changed_by, change_reason, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          versionId,
          id,
          newVersion,
          JSON.stringify(lineItems),
          totals.grandTotal,
          quote.terms_and_conditions || null,
          null,
          changedBy || 'system',
          changeReason || 'Quote updated'
        ]
      );
      
      await db.query('COMMIT');
      
      const { rows: updatedQuoteRows } = await db.query(
        'SELECT * FROM quotes WHERE id = $1',
        [id]
      );
      
      const updatedQuote = snakeToCamel(updatedQuoteRows[0]);
      
      const { rows: versionRows } = await db.query(
        'SELECT * FROM quote_versions WHERE quote_id = $1 ORDER BY version_number DESC',
        [id]
      );
      updatedQuote.versions = versionRows.map(snakeToCamel);
      
      res.json({ success: true, data: updatedQuote });
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/quotes/:id/versions - Get version history
apiRouter.get('/quotes/:id/versions', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows: quoteRows } = await db.query(
      'SELECT id FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const { rows: versionRows } = await db.query(
      'SELECT * FROM quote_versions WHERE quote_id = $1 ORDER BY version_number DESC',
      [id]
    );
    
    const versions = versionRows.map(snakeToCamel);
    
    res.json({ success: true, data: versions });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quotes/:id/approve - Approve quote
apiRouter.post('/quotes/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeUUID(id);
    
    if (!sanitizedId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid quote ID'
      });
    }
    
    let { approvedBy, notes } = req.body;
    
    // Sanitize approvedBy - convert "undefined" string or empty string to null
    approvedBy = sanitizeUUID(approvedBy);
    
    const { rows: quoteRows } = await db.query(
      'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [sanitizedId]
    );
    
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const updateQuery = `
      UPDATE quotes
      SET approval_status = 'approved',
          approved_at = NOW(),
          approved_by = $1,
          internal_notes = COALESCE(internal_notes, '') || $2,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `;
    
    const approvalNote = notes ? `\n[Approved: ${notes}]` : '\n[Approved]';
    
    const { rows: updatedRows } = await db.query(updateQuery, [
      approvedBy || 'system',
      approvalNote,
      sanitizedId
    ]);
    
    const quote = snakeToCamel(updatedRows[0]);
    
    res.json({ success: true, data: quote });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quotes/:id/reject - Reject quote
apiRouter.post('/quotes/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body;
    
    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        error: 'rejectionReason is required'
      });
    }
    
    const { rows: quoteRows } = await db.query(
      'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const updateQuery = `
      UPDATE quotes
      SET approval_status = 'rejected',
          internal_notes = COALESCE(internal_notes, '') || $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `;
    
    const rejectionNote = `\n[Rejected: ${rejectionReason}]`;
    
    const { rows: updatedRows } = await db.query(updateQuery, [
      rejectionNote,
      id
    ]);
    
    const quote = snakeToCamel(updatedRows[0]);
    
    res.json({ success: true, data: quote });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quotes/:id/send - Send quote to client
apiRouter.post('/quotes/:id/send', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows: quoteRows } = await db.query(
      'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const quote = quoteRows[0];
    
    const updateQuery = `
      UPDATE quotes
      SET status = CASE WHEN status = 'Draft' THEN 'Sent' ELSE status END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    
    const { rows: updatedRows } = await db.query(updateQuery, [id]);
    
    const updatedQuote = snakeToCamel(updatedRows[0]);
    
    // Emit quote_sent event
    try {
      await emitBusinessEvent('quote_sent', {
        id: updatedQuote.id,
        ...updatedQuote
      });
    } catch (e) {
      console.error('[Automation] Failed to emit quote_sent:', e.message);
    }
    
    res.json({
      success: true,
      data: updatedQuote,
      message: 'Quote status updated. Email notification would be sent here.'
    });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quotes/:id/convert-to-job - Convert quote to job
apiRouter.post('/quotes/:id/convert-to-job', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeUUID(id);
    
    if (!sanitizedId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid quote ID'
      });
    }
    
    await db.query('BEGIN');
    
    try {
      const { rows: quoteRows } = await db.query(
        'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
        [sanitizedId]
      );
      
      if (quoteRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Quote not found'
        });
      }
      
      const quote = quoteRows[0];
      
      // Business Rule: Only allow Sent or Accepted quotes to be converted to jobs
      // Block Draft, Pending, Rejected, and Converted quotes
      const allowedStatuses = ['Sent', 'Accepted'];
      
      if (!allowedStatuses.includes(quote.status)) {
        await db.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Cannot convert quote with status '${quote.status}' to job. Quote must be 'Sent' or 'Accepted'.`
        });
      }
      
      // Check approval status if the column exists and has a value
      if (quote.approval_status === 'rejected') {
        await db.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Cannot convert rejected quote to job'
        });
      }

      // Fetch client info for customer contact details
      let customerPhone = null;
      let customerEmail = null;
      let customerAddress = null;
      
      if (quote.client_id) {
        const { rows: clientRows } = await db.query(
          `SELECT primary_phone, primary_email, 
                  billing_address_line1, billing_city, billing_state, billing_zip_code
           FROM clients WHERE id = $1`,
          [quote.client_id]
        );
        if (clientRows.length > 0) {
          const client = clientRows[0];
          customerPhone = client.primary_phone || null;
          customerEmail = client.primary_email || null;
          // Build full address from billing address fields
          const addressParts = [
            client.billing_address_line1,
            client.billing_city,
            client.billing_state,
            client.billing_zip_code
          ].filter(Boolean);
          customerAddress = addressParts.length > 0 ? addressParts.join(', ') : null;
        }
      }
      
      // If property exists, use property address for job location
      let jobLocation = quote.job_location;
      if (quote.property_id) {
        const { rows: propRows } = await db.query(
          `SELECT address_line1, city, state, zip_code FROM properties WHERE id = $1`,
          [quote.property_id]
        );
        if (propRows.length > 0) {
          const prop = propRows[0];
          const propAddressParts = [prop.address_line1, prop.city, prop.state, prop.zip_code].filter(Boolean);
          if (propAddressParts.length > 0) {
            jobLocation = propAddressParts.join(', ');
          }
        }
      }

      const templateMatch = await automationService.matchTemplateForQuote(quote, db);
      const matchedTemplate = templateMatch?.template;

      const equipmentNeeded = matchedTemplate?.default_equipment_ids
        ? JSON.stringify(matchedTemplate.default_equipment_ids)
        : null;
      const completionChecklist = matchedTemplate?.completion_checklist
        ? JSON.stringify(matchedTemplate.completion_checklist)
        : null;

      const jobId = uuidv4();
      const jobNumber = await generateJobNumber();

      const insertJobQuery = `
        INSERT INTO jobs (
          id, client_id, property_id, quote_id, job_number, status,
          customer_name, customer_phone, customer_email, customer_address,
          job_location, special_instructions,
          equipment_needed, estimated_hours,
          completion_checklist, jha_required, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, 'scheduled', $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, NOW()
        ) RETURNING *
      `;

      const { rows: jobRows } = await db.query(insertJobQuery, [
        jobId,
        quote.client_id,
        quote.property_id,
        sanitizedId,
        jobNumber,
        quote.customer_name || 'Unknown',
        customerPhone,
        customerEmail,
        customerAddress,
        jobLocation || null,
        quote.special_instructions || null,
        equipmentNeeded,
        matchedTemplate?.default_duration_hours || null,
        completionChecklist,
        matchedTemplate?.jha_required || false
      ]);
      
      await db.query(
        `UPDATE quotes SET status = 'Converted', updated_at = NOW() WHERE id = $1`,
        [sanitizedId]
      );
      
      await db.query('COMMIT');
      
      const job = transformRow(jobRows[0], 'jobs');
      
      res.status(201).json({
        success: true,
        data: job,
        message: 'Quote successfully converted to job'
      });
      
      reindexDocument('jobs', jobRows[0]);
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/jobs - List jobs with quote metadata for operational context
apiRouter.get('/jobs', async (req, res) => {
  try {
    const jobQuery = `
      SELECT
        j.*,
        q.quote_number,
        q.version AS quote_version,
        q.approval_status AS quote_approval_status,
        q.approved_by AS quote_approved_by,
        q.approved_at AS quote_approved_at
      FROM jobs j
      LEFT JOIN quotes q ON q.id = j.quote_id
    `;

    const { rows } = await db.query(jobQuery);
    const jobs = rows.map(row => transformRow(row, 'jobs'));

    res.json(jobs);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/jobs/:id - Get a single job with quote metadata
apiRouter.get('/jobs/:id', async (req, res) => {
  try {
    const jobQuery = `
      SELECT
        j.*,
        q.quote_number,
        q.version AS quote_version,
        q.approval_status AS quote_approval_status,
        q.approved_by AS quote_approved_by,
        q.approved_at AS quote_approved_at
      FROM jobs j
      LEFT JOIN quotes q ON q.id = j.quote_id
      WHERE j.id = $1
    `;

    const { rows } = await db.query(jobQuery, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(transformRow(rows[0], 'jobs'));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/jobs - Custom create with client auto-linking
apiRouter.post('/jobs', async (req, res) => {
  try {
    const jobData = req.body;
    const sanitizedClientId = sanitizeUUID(jobData.clientId);
    let associatedClientId = sanitizedClientId;
    let clientRecord = null;

    if (jobData.customerDetails) {
      try {
        const ensured = await ensureClientAssociation({
          clientId: sanitizedClientId,
          customerDetails: jobData.customerDetails
        });
        associatedClientId = ensured.clientId;
        clientRecord = ensured.client;
      } catch (clientErr) {
        return res.status(400).json({ error: clientErr.message });
      }
    } else if (!associatedClientId) {
      return res.status(400).json({ error: 'Client information is required to create a job' });
    }

    delete jobData.customerDetails;

    if (!jobData.customerName) {
      if (clientRecord) {
        jobData.customerName = clientRecord.company_name || `${clientRecord.first_name || ''} ${clientRecord.last_name || ''}`.trim() || 'Unknown';
      } else {
        const { rows: fallbackRows } = await db.query(
          'SELECT company_name, first_name, last_name FROM clients WHERE id = $1',
          [associatedClientId]
        );
        const fallbackClient = fallbackRows[0];
        jobData.customerName = fallbackClient
          ? fallbackClient.company_name || `${fallbackClient.first_name || ''} ${fallbackClient.last_name || ''}`.trim() || 'Unknown'
          : 'Unknown';
      }
    }

    const payload = { ...jobData, clientId: associatedClientId };
    const dbData = transformToDb(payload, 'jobs');
    if (!dbData.job_number) {
      dbData.job_number = await generateJobNumber();
    }

    // Ensure 'id' is not duplicated in the columns
    delete dbData.id;

    const jobId = uuidv4();
    const columns = Object.keys(dbData);
    const values = columns.map((key) => dbData[key]);
    const placeholders = columns.map((_, index) => `$${index + 2}`).join(', ');

    const insertQuery = `
      INSERT INTO jobs (id, ${columns.join(', ')})
      VALUES ($1, ${placeholders})
      RETURNING *
    `;

    const { rows } = await db.query(insertQuery, [jobId, ...values]);
    const jobRow = rows[0];
    await updateClientCategoryFromJobs(associatedClientId);

    const job = transformRow(jobRow, 'jobs');
    res.status(201).json(job);

    reindexDocument('jobs', jobRow);
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/jobs/:id - Custom update with client categorization
apiRouter.put('/jobs/:id', async (req, res) => {
  try {
    const jobId = req.params.id;
    const sanitizedId = sanitizeUUID(jobId);

    if (!sanitizedId) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }

    const jobData = req.body;
    const { rows: existingRows } = await db.query('SELECT * FROM jobs WHERE id = $1', [sanitizedId]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const existingJob = existingRows[0];
    const previousStatus = existingJob.status;
    const incomingClientId = sanitizeUUID(jobData.clientId) || existingJob.client_id;
    let associatedClientId = incomingClientId;
    let clientRecord = null;

    if (jobData.customerDetails) {
      try {
        const ensured = await ensureClientAssociation({
          clientId: incomingClientId,
          customerDetails: jobData.customerDetails
        });
        associatedClientId = ensured.clientId;
        clientRecord = ensured.client;
      } catch (clientErr) {
        return res.status(400).json({ error: clientErr.message });
      }
    }

    delete jobData.customerDetails;

    if (!jobData.customerName && clientRecord) {
      jobData.customerName = clientRecord.company_name || `${clientRecord.first_name || ''} ${clientRecord.last_name || ''}`.trim() || 'Unknown';
    }

    const payload = { ...jobData, clientId: associatedClientId };
    const dbData = transformToDb(payload, 'jobs');

    if (Object.keys(dbData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const columns = Object.keys(dbData);
    const values = columns.map((key, index) => dbData[key]);
    const setString = columns.map((col, index) => `${col} = $${index + 2}`).join(', ');
    const updateQuery = `UPDATE jobs SET ${setString}, updated_at = NOW() WHERE id = $1 RETURNING *`;

    const { rows: updatedRows } = await db.query(updateQuery, [sanitizedId, ...values]);
    if (updatedRows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const updatedJob = updatedRows[0];
    await updateClientCategoryFromJobs(associatedClientId);
    if (existingJob.client_id && existingJob.client_id !== associatedClientId) {
      await updateClientCategoryFromJobs(existingJob.client_id);
    }

    const response = transformRow(updatedJob, 'jobs');

    // Auto-generate invoice when jobs are marked completed via direct updates
    if (
      previousStatus !== updatedJob.status &&
      String(updatedJob.status || '').toLowerCase() === 'completed'
    ) {
      try {
        await jobStateService.AUTOMATED_TRIGGERS.completed(
          updatedJob,
          { fromState: previousStatus, toState: 'completed' },
          db
        );
      } catch (automationError) {
        console.error('⚠️ Failed to auto-invoice completed job:', automationError.message);
      }
    }

    res.json(response);

    reindexDocument('jobs', updatedJob);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quotes/:id/followups - Schedule follow-up
apiRouter.post('/quotes/:id/followups', async (req, res) => {
  try {
    const { id } = req.params;
    const { followupType, scheduledDate, subject, message } = req.body;
    
    if (!followupType || !scheduledDate) {
      return res.status(400).json({
        success: false,
        error: 'followupType and scheduledDate are required'
      });
    }
    
    const { rows: quoteRows } = await db.query(
      'SELECT id FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const followupId = uuidv4();
    
    const insertQuery = `
      INSERT INTO quote_followups (
        id, quote_id, followup_type, scheduled_date, subject,
        message, status, is_automated, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'scheduled', false, NOW()
      ) RETURNING *
    `;
    
    const { rows: followupRows } = await db.query(insertQuery, [
      followupId,
      id,
      followupType,
      scheduledDate,
      subject || null,
      message || null
    ]);
    
    const followup = snakeToCamel(followupRows[0]);
    
    res.status(201).json({ success: true, data: followup });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/quotes/:id/followups - Get quote follow-ups
apiRouter.get('/quotes/:id/followups', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows: quoteRows } = await db.query(
      'SELECT id FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quote not found'
      });
    }
    
    const { rows: followupRows } = await db.query(
      'SELECT * FROM quote_followups WHERE quote_id = $1 ORDER BY scheduled_date ASC',
      [id]
    );
    
    const followups = followupRows.map(snakeToCamel);
    
    res.json({ success: true, data: followups });
    
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/quote-followups/:id - Update follow-up
apiRouter.put('/quote-followups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, completedBy, clientResponse, outcome } = req.body;
    
    const { rows: existingRows } = await db.query(
      'SELECT * FROM quote_followups WHERE id = $1',
      [id]
    );
    
    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Follow-up not found'
      });
    }
    
    const updates = [];
    const values = [id];
    let paramIndex = 2;
    
    if (status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
      
      if (status === 'completed') {
        updates.push(`completed_at = NOW()`);
      }
    }
    
    if (completedBy !== undefined) {
      updates.push(`completed_by = $${paramIndex}`);
      values.push(completedBy);
      paramIndex++;
    }
    
    if (clientResponse !== undefined) {
      updates.push(`client_response = $${paramIndex}`);
      values.push(clientResponse);
      paramIndex++;
    }
    
    if (outcome !== undefined) {
      updates.push(`outcome = $${paramIndex}`);
      values.push(outcome);
      paramIndex++;
    }
    
    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }
    
    updates.push(`updated_at = NOW()`);
    
    const updateQuery = `
      UPDATE quote_followups
      SET ${updates.join(', ')}
      WHERE id = $1
      RETURNING *
    `;
    
    const { rows: updatedRows } = await db.query(updateQuery, values);
    const followup = snakeToCamel(updatedRows[0]);
    
    res.json({ success: true, data: followup });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/quotes/pending-followups - Get quotes needing follow-up
apiRouter.get('/quotes/pending-followups', async (req, res) => {
  try {
    const queryText = `
      SELECT 
        qf.*,
        q.quote_number,
        q.status as quote_status,
        q.grand_total,
        c.first_name as client_first_name,
        c.last_name as client_last_name,
        c.company_name as client_company_name,
        c.primary_email as client_email,
        c.primary_phone as client_phone
      FROM quote_followups qf
      INNER JOIN quotes q ON qf.quote_id = q.id
      LEFT JOIN clients c ON q.client_id = c.id
      WHERE qf.status = 'scheduled'
        AND qf.scheduled_date <= CURRENT_DATE
        AND q.deleted_at IS NULL
      ORDER BY qf.scheduled_date ASC
    `;
    
    const { rows } = await db.query(queryText);
    
    const followups = rows.map(row => {
      const followup = snakeToCamel(row);
      
      followup.quote = {
        quoteNumber: row.quote_number,
        status: row.quote_status,
        grandTotal: row.grand_total
      };
      
      if (row.client_first_name || row.client_company_name) {
        followup.client = {
          firstName: row.client_first_name,
          lastName: row.client_last_name,
          companyName: row.client_company_name,
          email: row.client_email,
          phone: row.client_phone
        };
      }
      
      delete followup.quoteNumber;
      delete followup.quoteStatus;
      delete followup.grandTotal;
      delete followup.clientFirstName;
      delete followup.clientLastName;
      delete followup.clientCompanyName;
      delete followup.clientEmail;
      delete followup.clientPhone;
      
      return followup;
    });
    
    res.json({ success: true, data: followups });
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// QUOTE TEMPLATE ENDPOINTS
// ============================================================================

// GET /api/quote-templates - List templates
apiRouter.get('/quote-templates', async (req, res) => {
  try {
    const { serviceCategory } = req.query;
    
    let queryText = 'SELECT * FROM quote_templates WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (serviceCategory) {
      queryText += ` AND service_category = $${paramIndex}`;
      params.push(serviceCategory);
      paramIndex++;
    }
    
    queryText += ' ORDER BY use_count DESC, name ASC';
    
    const { rows } = await db.query(queryText, params);
    const templates = rows.map(snakeToCamel);
    
    res.json({ success: true, data: templates });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quote-templates - Create template
apiRouter.post('/quote-templates', async (req, res) => {
  try {
    const {
      name,
      description,
      lineItems,
      termsAndConditions,
      serviceCategory,
      validDays,
      depositPercentage,
      paymentTerms,
      createdBy
    } = req.body;
    
    if (!name || !lineItems) {
      return res.status(400).json({
        success: false,
        error: 'name and lineItems are required'
      });
    }
    
    const templateId = uuidv4();
    
    const insertQuery = `
      INSERT INTO quote_templates (
        id, name, description, line_items, terms_and_conditions,
        valid_days, deposit_percentage, payment_terms, service_category,
        is_active, use_count, created_by, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, true, 0, $10, NOW()
      ) RETURNING *
    `;
    
    const { rows } = await db.query(insertQuery, [
      templateId,
      name,
      description || null,
      JSON.stringify(lineItems),
      termsAndConditions || null,
      validDays || 30,
      depositPercentage || 0,
      paymentTerms || 'Net 30',
      serviceCategory || null,
      createdBy || 'system'
    ]);
    
    const template = snakeToCamel(rows[0]);
    
    res.status(201).json({ success: true, data: template });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/quote-templates/:id - Get template details
apiRouter.get('/quote-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows } = await db.query(
      'SELECT * FROM quote_templates WHERE id = $1',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Template not found'
      });
    }
    
    const template = snakeToCamel(rows[0]);
    
    res.json({ success: true, data: template });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/quotes/from-template/:templateId - Create quote from template
apiRouter.post('/quotes/from-template/:templateId', async (req, res) => {
  try {
    const { templateId } = req.params;
    const { clientId, propertyId, leadId } = req.body;
    
    await db.query('BEGIN');
    
    try {
      const { rows: templateRows } = await db.query(
        'SELECT * FROM quote_templates WHERE id = $1 AND is_active = true',
        [templateId]
      );
      
      if (templateRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Template not found or inactive'
        });
      }
      
      const template = templateRows[0];
      
      const quoteId = uuidv4();
      const quoteNumber = await generateQuoteNumber();
      
      const lineItems = typeof template.line_items === 'string' 
        ? JSON.parse(template.line_items) 
        : template.line_items;
      
      const totals = calculateQuoteTotals(lineItems, 0, 0, 0);
      
      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + (template.valid_days || 30));
      
      const insertQuoteQuery = `
        INSERT INTO quotes (
          id, client_id, property_id, lead_id, quote_number, version,
          approval_status, line_items, total_amount, discount_amount,
          discount_percentage, tax_rate, tax_amount, grand_total,
          terms_and_conditions, status, valid_until, deposit_amount,
          payment_terms, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, 1, 'pending', $6, $7, 0, 0, 0, 0, $8,
          $9, 'Draft', $10, $11, $12, NOW()
        ) RETURNING *
      `;
      
      const { rows: quoteRows } = await db.query(insertQuoteQuery, [
        quoteId,
        clientId || null,
        propertyId || null,
        leadId || null,
        quoteNumber,
        JSON.stringify(lineItems),
        totals.totalAmount,
        totals.grandTotal,
        template.terms_and_conditions || null,
        validUntil.toISOString().split('T')[0],
        (totals.grandTotal * (template.deposit_percentage || 0)) / 100,
        template.payment_terms || 'Net 30'
      ]);
      
      const versionId = uuidv4();
      await db.query(
        `INSERT INTO quote_versions (
          id, quote_id, version_number, line_items, total_amount,
          terms, notes, changed_by, change_reason, created_at
        ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          versionId,
          quoteId,
          JSON.stringify(lineItems),
          totals.grandTotal,
          template.terms_and_conditions || null,
          `Created from template: ${template.name}`,
          'system',
          'Quote created from template'
        ]
      );
      
      await db.query(
        'UPDATE quote_templates SET use_count = use_count + 1, updated_at = NOW() WHERE id = $1',
        [templateId]
      );
      
      await db.query('COMMIT');
      
      const quote = snakeToCamel(quoteRows[0]);
      
      res.status(201).json({
        success: true,
        data: quote,
        message: `Quote created from template: ${template.name}`
      });
      
      reindexDocument('quotes', quoteRows[0]);
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// JOB STATE MACHINE ENDPOINTS
// ============================================================================

// GET /api/jobs/:id/state-history - Get state transition history for a job
apiRouter.get('/jobs/:id/state-history', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify job exists
    const job = await jobStateService.getJob(id);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    // Get complete state transition history
    const history = await jobStateService.getStateHistory(id);
    
    res.json({
      success: true,
      data: {
        jobId: id,
        currentState: job.status,
        currentStateName: jobStateService.STATE_NAMES[job.status],
        history
      }
    });
    
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/jobs/:id/state-transitions - Transition job to new state
apiRouter.post('/jobs/:id/state-transitions', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      toState, 
      reason, 
      notes,
      changedByRole = 'admin',
      changeSource = 'manual',
      jobUpdates = {}
    } = req.body;
    
    // Use session user ID or null (not hardcoded string)
    const changedBy = req.session?.userId || null;
    
    // Validate required fields
    if (!toState) {
      return res.status(400).json({
        success: false,
        error: 'toState is required'
      });
    }
    
    // Verify job exists
    const job = await jobStateService.getJob(id);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    // Attempt state transition
    const result = await jobStateService.transitionJobState(id, toState, {
      changedBy,
      changedByRole,
      changeSource,
      reason,
      notes,
      jobUpdates
    });
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        errors: result.errors
      });
    }

    if (result.job?.client_id) {
      await updateClientCategoryFromJobs(result.job.client_id);
    }

    // Re-index job in RAG system after state change
    await reindexDocument('jobs', result.job);
    
    res.json({
      success: true,
      data: {
        job: transformRow(result.job, 'jobs'),
        transition: result.transition
      },
      message: `Job transitioned from '${result.transition.from}' to '${result.transition.to}'`
    });
    
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/jobs/:id/allowed-transitions - Get currently allowed transitions for a job
apiRouter.get('/jobs/:id/allowed-transitions', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get allowed transitions with validation context
    const result = await jobStateService.getAllowedTransitionsForJob(id);
    
    if (result.error) {
      return res.status(404).json({
        success: false,
        error: result.error
      });
    }
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// JOB TEMPLATES ENDPOINTS
// ============================================================================

// GET /api/job-templates - List all templates with filters
apiRouter.get('/job-templates', async (req, res) => {
  try {
    const { category, search, limit } = req.query;
    
    const filters = {
      category,
      search,
      limit: limit ? parseInt(limit) : undefined
    };
    
    const templates = await jobTemplateService.getAllTemplates(filters);
    
    res.json({
      success: true,
      data: templates
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/job-templates/by-category - Get templates grouped by category
apiRouter.get('/job-templates/by-category', async (req, res) => {
  try {
    const grouped = await jobTemplateService.getTemplatesByCategory();
    
    res.json({
      success: true,
      data: grouped
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/job-templates/usage-stats - Get template usage statistics
apiRouter.get('/job-templates/usage-stats', async (req, res) => {
  try {
    const stats = await jobTemplateService.getUsageStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/job-templates/:id - Get template details
apiRouter.get('/job-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const template = await jobTemplateService.getTemplateById(id);
    
    res.json({
      success: true,
      data: template
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: err.message
      });
    }
    handleError(res, err);
  }
});

// POST /api/job-templates - Create new template
apiRouter.post('/job-templates', async (req, res) => {
  try {
    const template = await jobTemplateService.createTemplate(req.body);
    
    res.status(201).json({
      success: true,
      data: template,
      message: 'Template created successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/job-templates/from-job/:jobId - Create template from existing job
apiRouter.post('/job-templates/from-job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const templateData = req.body;
    
    const template = await jobTemplateService.createTemplateFromJob(jobId, templateData);
    
    res.status(201).json({
      success: true,
      data: template,
      message: 'Template created from job successfully'
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: err.message
      });
    }
    handleError(res, err);
  }
});

// PUT /api/job-templates/:id - Update template
apiRouter.put('/job-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const template = await jobTemplateService.updateTemplate(id, req.body);
    
    res.json({
      success: true,
      data: template,
      message: 'Template updated successfully'
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: err.message
      });
    }
    handleError(res, err);
  }
});

// DELETE /api/job-templates/:id - Soft delete template
apiRouter.delete('/job-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await jobTemplateService.deleteTemplate(id);
    
    res.json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: err.message
      });
    }
    handleError(res, err);
  }
});

// POST /api/job-templates/:id/use - Create job from template
apiRouter.post('/job-templates/:id/use', async (req, res) => {
  try {
    const { id } = req.params;
    const jobData = req.body;
    
    const job = await jobTemplateService.useTemplate(id, jobData);
    
    // Re-index job in RAG system
    await reindexDocument('jobs', job);
    
    res.status(201).json({
      success: true,
      data: transformRow(job, 'jobs'),
      message: 'Job created from template successfully'
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: err.message
      });
    }
    handleError(res, err);
  }
});

// ============================================================================
// JOB FORMS ENDPOINTS (Phase 2B)
// ============================================================================

// ----------------------
// FORM TEMPLATES ENDPOINTS
// ----------------------

// GET /api/form-templates - List all form templates with filters
apiRouter.get('/form-templates', async (req, res) => {
  try {
    const { category, search, active } = req.query;
    
    let query = 'SELECT * FROM form_templates WHERE deleted_at IS NULL';
    const params = [];
    let paramCount = 1;
    
    // Filter by category (form_type in the database)
    if (category) {
      query += ` AND form_type = $${paramCount}`;
      params.push(category);
      paramCount++;
    }
    
    // Filter by active status
    if (active !== undefined) {
      query += ` AND is_active = $${paramCount}`;
      params.push(active === 'true');
      paramCount++;
    }
    
    // Search by name or description
    if (search) {
      query += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }
    
    query += ' ORDER BY created_at DESC';
    
    const { rows } = await db.query(query, params);
    const templates = rows.map(row => transformRow(row, 'form_templates'));
    
    res.json({
      success: true,
      data: templates
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/form-templates/categories - Get list of unique categories
apiRouter.get('/form-templates/categories', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT form_type as category
      FROM form_templates
      WHERE deleted_at IS NULL AND form_type IS NOT NULL
      ORDER BY form_type
    `);
    
    const categories = rows.map(row => row.category);
    
    res.json({
      success: true,
      data: categories
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/form-templates/:id - Get single template by ID
apiRouter.get('/form-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows } = await db.query(
      'SELECT * FROM form_templates WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Form template not found'
      });
    }
    
    const template = transformRow(rows[0], 'form_templates');
    
    res.json({
      success: true,
      data: template
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/form-templates - Create new form template
apiRouter.post('/form-templates', async (req, res) => {
  try {
    const {
      name,
      description,
      formType,
      fields,
      requireSignature,
      requirePhotos,
      minPhotos
    } = req.body;
    
    // Validation
    if (!name || !fields) {
      return res.status(400).json({
        success: false,
        error: 'Name and fields are required'
      });
    }
    
    if (!Array.isArray(fields)) {
      return res.status(400).json({
        success: false,
        error: 'Fields must be an array'
      });
    }
    
    // Validate field structure
    for (const field of fields) {
      if (!field.id || !field.type || !field.label) {
        return res.status(400).json({
          success: false,
          error: 'Each field must have id, type, and label'
        });
      }
    }
    
    const { rows } = await db.query(
      `INSERT INTO form_templates (
        name, description, form_type, fields, 
        require_signature, require_photos, min_photos
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        name,
        description || null,
        formType || null,
        JSON.stringify(fields),
        requireSignature || false,
        requirePhotos || false,
        minPhotos || null
      ]
    );
    
    const template = transformRow(rows[0], 'form_templates');
    
    res.status(201).json({
      success: true,
      data: template,
      message: 'Form template created successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/form-templates/:id - Update template
apiRouter.put('/form-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      formType,
      fields,
      isActive,
      requireSignature,
      requirePhotos,
      minPhotos
    } = req.body;
    
    // Check if template exists
    const { rows: existing } = await db.query(
      'SELECT * FROM form_templates WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Form template not found'
      });
    }
    
    // Build update query dynamically
    const updates = [];
    const params = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount}`);
      params.push(name);
      paramCount++;
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      params.push(description);
      paramCount++;
    }
    if (formType !== undefined) {
      updates.push(`form_type = $${paramCount}`);
      params.push(formType);
      paramCount++;
    }
    if (fields !== undefined) {
      if (!Array.isArray(fields)) {
        return res.status(400).json({
          success: false,
          error: 'Fields must be an array'
        });
      }
      updates.push(`fields = $${paramCount}`);
      params.push(JSON.stringify(fields));
      paramCount++;
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramCount}`);
      params.push(isActive);
      paramCount++;
    }
    if (requireSignature !== undefined) {
      updates.push(`require_signature = $${paramCount}`);
      params.push(requireSignature);
      paramCount++;
    }
    if (requirePhotos !== undefined) {
      updates.push(`require_photos = $${paramCount}`);
      params.push(requirePhotos);
      paramCount++;
    }
    if (minPhotos !== undefined) {
      updates.push(`min_photos = $${paramCount}`);
      params.push(minPhotos);
      paramCount++;
    }
    
    updates.push(`updated_at = NOW()`);
    params.push(id);
    
    const { rows } = await db.query(
      `UPDATE form_templates SET ${updates.join(', ')}
       WHERE id = $${paramCount} RETURNING *`,
      params
    );
    
    const template = transformRow(rows[0], 'form_templates');
    
    res.json({
      success: true,
      data: template,
      message: 'Form template updated successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/form-templates/:id - Soft delete template (set is_active = false)
apiRouter.delete('/form-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows } = await db.query(
      `UPDATE form_templates 
       SET is_active = false, deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Form template not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Form template deleted successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/form-templates/seed - Seed sample form templates
apiRouter.post('/form-templates/seed', async (req, res) => {
  try {
    const sampleTemplates = [
      {
        name: 'Pre-Job Safety Checklist',
        description: 'Mandatory safety checklist to be completed before starting any tree work',
        form_type: 'safety',
        fields: [
          { id: 'ppe_check', type: 'checkbox', label: 'All crew members wearing proper PPE (helmet, gloves, safety glasses, boots)', required: true },
          { id: 'equipment_inspection', type: 'checkbox', label: 'All equipment inspected and in safe working condition', required: true },
          { id: 'drop_zone', type: 'checkbox', label: 'Drop zone clearly marked and secured', required: true },
          { id: 'traffic_control', type: 'checkbox', label: 'Traffic control measures in place (if applicable)', required: false },
          { id: 'power_lines', type: 'select', label: 'Power line proximity status', required: true, options: ['No power lines nearby', 'Power lines present - keeping safe distance', 'Power company notified'] },
          { id: 'weather_conditions', type: 'select', label: 'Weather conditions', required: true, options: ['Clear and safe', 'Marginal - monitoring', 'Unsafe - work postponed'] },
          { id: 'emergency_plan', type: 'checkbox', label: 'Emergency action plan reviewed with crew', required: true },
          { id: 'first_aid_kit', type: 'checkbox', label: 'First aid kit accessible on site', required: true },
          { id: 'additional_hazards', type: 'textarea', label: 'Additional hazards identified', required: false },
          { id: 'crew_leader_name', type: 'text', label: 'Crew Leader Name', required: true },
          { id: 'checklist_date', type: 'date', label: 'Date', required: true }
        ],
        require_signature: true,
        is_active: true
      },
      {
        name: 'Tree Removal Inspection',
        description: 'Detailed inspection form for tree removal assessment and documentation',
        form_type: 'inspection',
        fields: [
          { id: 'tree_species', type: 'text', label: 'Tree Species', required: true },
          { id: 'tree_height', type: 'number', label: 'Estimated Height (feet)', required: true },
          { id: 'trunk_diameter', type: 'number', label: 'Trunk Diameter (inches)', required: true },
          { id: 'tree_health', type: 'select', label: 'Tree Health Assessment', required: true, options: ['Healthy', 'Declining', 'Dead', 'Hazardous'] },
          { id: 'decay_present', type: 'checkbox', label: 'Signs of decay or rot present', required: false },
          { id: 'structural_defects', type: 'textarea', label: 'Structural defects noted', required: false },
          { id: 'obstacles', type: 'textarea', label: 'Nearby obstacles (buildings, fences, utilities)', required: true },
          { id: 'access_notes', type: 'textarea', label: 'Site access notes', required: false },
          { id: 'recommended_equipment', type: 'textarea', label: 'Recommended equipment for removal', required: true },
          { id: 'crew_size', type: 'number', label: 'Recommended crew size', required: true },
          { id: 'estimated_duration', type: 'number', label: 'Estimated duration (hours)', required: true },
          { id: 'special_precautions', type: 'textarea', label: 'Special precautions required', required: false },
          { id: 'inspector_name', type: 'text', label: 'Inspector Name', required: true },
          { id: 'inspection_date', type: 'date', label: 'Inspection Date', required: true }
        ],
        require_signature: true,
        require_photos: true,
        min_photos: 3,
        is_active: true
      },
      {
        name: 'Equipment Check',
        description: 'Daily equipment inspection and maintenance check',
        form_type: 'equipment',
        fields: [
          { id: 'equipment_type', type: 'select', label: 'Equipment Type', required: true, options: ['Chainsaw', 'Chipper', 'Bucket Truck', 'Stump Grinder', 'Climbing Gear', 'Other'] },
          { id: 'equipment_id', type: 'text', label: 'Equipment ID/Serial Number', required: true },
          { id: 'visual_inspection', type: 'checkbox', label: 'Visual inspection completed - no visible damage', required: true },
          { id: 'fluid_levels', type: 'checkbox', label: 'Fluid levels checked and adequate', required: true },
          { id: 'safety_features', type: 'checkbox', label: 'All safety features functional', required: true },
          { id: 'blade_chain_condition', type: 'select', label: 'Blade/Chain condition', required: true, options: ['Good - sharp', 'Acceptable', 'Needs sharpening', 'Needs replacement'] },
          { id: 'operational_test', type: 'checkbox', label: 'Operational test passed', required: true },
          { id: 'maintenance_needed', type: 'checkbox', label: 'Maintenance required', required: false },
          { id: 'maintenance_notes', type: 'textarea', label: 'Maintenance notes/issues identified', required: false },
          { id: 'hour_meter_reading', type: 'number', label: 'Hour meter reading', required: false },
          { id: 'inspector_name', type: 'text', label: 'Inspector Name', required: true },
          { id: 'inspection_date', type: 'date', label: 'Inspection Date', required: true }
        ],
        require_signature: true,
        is_active: true
      },
      {
        name: 'Customer Approval Form',
        description: 'Customer sign-off and approval documentation for completed work',
        form_type: 'approval',
        fields: [
          { id: 'customer_name', type: 'text', label: 'Customer Name', required: true },
          { id: 'work_completed', type: 'textarea', label: 'Work completed description', required: true },
          { id: 'customer_satisfaction', type: 'select', label: 'Customer satisfaction level', required: true, options: ['Very Satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very Dissatisfied'] },
          { id: 'work_quality', type: 'checkbox', label: 'Work completed to customer satisfaction', required: true },
          { id: 'cleanup_complete', type: 'checkbox', label: 'Site cleanup completed', required: true },
          { id: 'debris_removed', type: 'checkbox', label: 'All debris removed from property', required: true },
          { id: 'property_condition', type: 'checkbox', label: 'Property left in good condition', required: true },
          { id: 'additional_work_requested', type: 'textarea', label: 'Additional work requested by customer', required: false },
          { id: 'customer_comments', type: 'textarea', label: 'Customer comments or concerns', required: false },
          { id: 'crew_leader_name', type: 'text', label: 'Crew Leader Name', required: true },
          { id: 'completion_date', type: 'date', label: 'Completion Date', required: true }
        ],
        require_signature: true,
        require_photos: true,
        min_photos: 2,
        is_active: true
      },
      {
        name: 'Job Completion Checklist',
        description: 'Internal checklist for job wrap-up and quality assurance',
        form_type: 'completion',
        fields: [
          { id: 'all_work_completed', type: 'checkbox', label: 'All work items from quote completed', required: true },
          { id: 'stumps_ground', type: 'checkbox', label: 'Stumps ground (if applicable)', required: false },
          { id: 'wood_hauled', type: 'checkbox', label: 'Wood hauled away or stacked as requested', required: true },
          { id: 'debris_removed', type: 'checkbox', label: 'All debris and branches removed', required: true },
          { id: 'site_raked', type: 'checkbox', label: 'Work area raked and cleaned', required: true },
          { id: 'equipment_removed', type: 'checkbox', label: 'All equipment removed from site', required: true },
          { id: 'no_property_damage', type: 'checkbox', label: 'No damage to customer property', required: true },
          { id: 'damage_notes', type: 'textarea', label: 'Property damage notes (if any)', required: false },
          { id: 'safety_incidents', type: 'checkbox', label: 'Any safety incidents occurred', required: false },
          { id: 'incident_details', type: 'textarea', label: 'Safety incident details', required: false },
          { id: 'additional_services_sold', type: 'textarea', label: 'Additional services sold on site', required: false },
          { id: 'crew_leader_name', type: 'text', label: 'Crew Leader Name', required: true },
          { id: 'completion_date', type: 'date', label: 'Completion Date', required: true }
        ],
        require_signature: true,
        require_photos: true,
        is_active: true
      }
    ];
    
    const inserted = [];
    const skipped = [];
    
    for (const template of sampleTemplates) {
      const { rows: existing } = await db.query(
        'SELECT id FROM form_templates WHERE name = $1 AND deleted_at IS NULL',
        [template.name]
      );
      
      if (existing.length > 0) {
        skipped.push(template.name);
        continue;
      }
      
      const { rows } = await db.query(
        `INSERT INTO form_templates (
          name, description, form_type, fields, require_signature, require_photos, min_photos, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          template.name,
          template.description,
          template.form_type,
          JSON.stringify(template.fields),
          template.require_signature || false,
          template.require_photos || false,
          template.min_photos || null,
          template.is_active
        ]
      );
      
      inserted.push(transformRow(rows[0], 'form_templates'));
    }
    
    res.json({
      success: true,
      data: { inserted, skipped },
      message: `Seeded ${inserted.length} templates, ${skipped.length} already existed`
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------
// JOB FORMS ENDPOINTS
// ----------------------

// POST /api/jobs/:jobId/forms - Attach form template to job, creates job_form instance
apiRouter.post('/jobs/:jobId/forms', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { formTemplateId } = req.body;
    
    if (!formTemplateId) {
      return res.status(400).json({
        success: false,
        error: 'formTemplateId is required'
      });
    }
    
    // Verify job exists
    const { rows: jobRows } = await db.query(
      'SELECT id FROM jobs WHERE id = $1',
      [jobId]
    );
    
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    // Verify form template exists and is active
    const { rows: templateRows } = await db.query(
      'SELECT * FROM form_templates WHERE id = $1 AND deleted_at IS NULL',
      [formTemplateId]
    );
    
    if (templateRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Form template not found'
      });
    }
    
    // Create job form
    const { rows } = await db.query(
      `INSERT INTO job_forms (job_id, form_template_id, status, form_data)
       VALUES ($1, $2, 'pending', '{}')
       RETURNING *`,
      [jobId, formTemplateId]
    );
    
    const jobForm = transformRow(rows[0], 'job_forms');
    
    res.status(201).json({
      success: true,
      data: jobForm,
      message: 'Form attached to job successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/jobs/:jobId/forms - Get all forms attached to a job
apiRouter.get('/jobs/:jobId/forms', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Verify job exists
    const { rows: jobRows } = await db.query(
      'SELECT id FROM jobs WHERE id = $1',
      [jobId]
    );
    
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    // Get all forms for this job with template details
    const { rows } = await db.query(
      `SELECT 
        jf.*,
        ft.name as template_name,
        ft.description as template_description,
        ft.form_type as template_form_type,
        ft.fields as template_fields,
        ft.require_signature,
        ft.require_photos,
        ft.min_photos
       FROM job_forms jf
       JOIN form_templates ft ON jf.form_template_id = ft.id
       WHERE jf.job_id = $1
       ORDER BY jf.created_at DESC`,
      [jobId]
    );
    
    const jobForms = rows.map(row => {
      const jobForm = transformRow(row, 'job_forms');
      jobForm.template = {
        name: row.template_name,
        description: row.template_description,
        formType: row.template_form_type,
        fields: row.template_fields,
        requireSignature: row.require_signature,
        requirePhotos: row.require_photos,
        minPhotos: row.min_photos
      };
      return jobForm;
    });
    
    res.json({
      success: true,
      data: jobForms
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/job-forms/:id - Get single job form with filled data
apiRouter.get('/job-forms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows } = await db.query(
      `SELECT 
        jf.*,
        ft.name as template_name,
        ft.description as template_description,
        ft.form_type as template_form_type,
        ft.fields as template_fields,
        ft.require_signature,
        ft.require_photos,
        ft.min_photos
       FROM job_forms jf
       JOIN form_templates ft ON jf.form_template_id = ft.id
       WHERE jf.id = $1`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job form not found'
      });
    }
    
    const jobForm = transformRow(rows[0], 'job_forms');
    jobForm.template = {
      name: rows[0].template_name,
      description: rows[0].template_description,
      formType: rows[0].template_form_type,
      fields: rows[0].template_fields,
      requireSignature: rows[0].require_signature,
      requirePhotos: rows[0].require_photos,
      minPhotos: rows[0].min_photos
    };
    
    res.json({
      success: true,
      data: jobForm
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/job-forms/:id/submit - Submit/update form data (field values)
apiRouter.put('/job-forms/:id/submit', async (req, res) => {
  try {
    const { id } = req.params;
    const { formData } = req.body;
    
    if (!formData || typeof formData !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'formData is required and must be an object'
      });
    }
    
    // Get job form with template
    const { rows: formRows } = await db.query(
      `SELECT jf.*, ft.fields as template_fields
       FROM job_forms jf
       JOIN form_templates ft ON jf.form_template_id = ft.id
       WHERE jf.id = $1`,
      [id]
    );
    
    if (formRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job form not found'
      });
    }
    
    // Validate field types match template
    const templateFields = formRows[0].template_fields;
    const errors = [];
    
    for (const field of templateFields) {
      const value = formData[field.id];
      
      if (value !== undefined && value !== null && value !== '') {
        // Type validation
        switch (field.type) {
          case 'number':
            if (isNaN(Number(value))) {
              errors.push(`Field '${field.label}' must be a number`);
            }
            break;
          case 'checkbox':
            if (typeof value !== 'boolean') {
              errors.push(`Field '${field.label}' must be a boolean`);
            }
            break;
          case 'date':
            if (isNaN(Date.parse(value))) {
              errors.push(`Field '${field.label}' must be a valid date`);
            }
            break;
        }
      }
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation errors',
        errors
      });
    }
    
    // Update form data
    const { rows } = await db.query(
      `UPDATE job_forms 
       SET form_data = $1, status = 'in_progress', updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(formData), id]
    );
    
    const jobForm = transformRow(rows[0], 'job_forms');
    
    res.json({
      success: true,
      data: jobForm,
      message: 'Form data updated successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/job-forms/:id/complete - Mark form as completed
apiRouter.put('/job-forms/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { completedBy } = req.body;
    
    // Get job form with template to validate required fields
    const { rows: formRows } = await db.query(
      `SELECT jf.*, ft.fields as template_fields
       FROM job_forms jf
       JOIN form_templates ft ON jf.form_template_id = ft.id
       WHERE jf.id = $1`,
      [id]
    );
    
    if (formRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job form not found'
      });
    }
    
    const jobForm = formRows[0];
    const templateFields = jobForm.template_fields;
    const formData = jobForm.form_data || {};
    
    // Validate required fields are filled
    const errors = [];
    for (const field of templateFields) {
      if (field.required) {
        const value = formData[field.id];
        if (value === undefined || value === null || value === '') {
          errors.push(`Required field '${field.label}' is not filled`);
        }
      }
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot complete form: required fields are missing',
        errors
      });
    }
    
    // Mark as completed
    const { rows } = await db.query(
      `UPDATE job_forms 
       SET status = 'completed', 
           completed_at = NOW(), 
           completed_by = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [completedBy || null, id]
    );
    
    const updatedJobForm = transformRow(rows[0], 'job_forms');
    
    res.json({
      success: true,
      data: updatedJobForm,
      message: 'Form marked as completed'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/job-forms/:id - Remove form from job
apiRouter.delete('/job-forms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows } = await db.query(
      'DELETE FROM job_forms WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job form not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Form removed from job successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// CREW MANAGEMENT ENDPOINTS
// ============================================================================

// ----------------------
// HELPER ENDPOINTS (must be before parameterized routes)
// ----------------------

// GET /api/crews/available - Get crews available on a specific date
apiRouter.get('/crews/available', async (req, res) => {
  try {
    const { date, exclude_job_id } = req.query;
    
    // Validation
    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'date query parameter is required'
      });
    }
    
    // Get crews that haven't reached capacity for the date
    let query = `
      SELECT 
        c.*,
        COUNT(DISTINCT cm.id) FILTER (WHERE cm.left_at IS NULL) as member_count,
        COUNT(DISTINCT ca.id) FILTER (WHERE ca.assigned_date = $1) as assignments_on_date
      FROM crews c
      LEFT JOIN crew_members cm ON c.id = cm.crew_id AND cm.left_at IS NULL
      LEFT JOIN crew_assignments ca ON c.id = ca.crew_id
      WHERE c.deleted_at IS NULL 
        AND c.is_active = true
      GROUP BY c.id
      HAVING 
        c.capacity IS NULL 
        OR COUNT(DISTINCT ca.id) FILTER (WHERE ca.assigned_date = $1) < c.capacity
      ORDER BY c.name
    `;
    
    const { rows } = await db.query(query, [date]);
    
    // Filter out crew if it's already assigned to the excluded job
    let crews = rows;
    if (exclude_job_id) {
      const excludeQuery = `
        SELECT crew_id FROM crew_assignments 
        WHERE job_id = $1 AND assigned_date = $2
      `;
      const { rows: excludeRows } = await db.query(excludeQuery, [exclude_job_id, date]);
      const excludedCrewIds = excludeRows.map(r => r.crew_id);
      
      crews = rows.filter(crew => !excludedCrewIds.includes(crew.id));
    }
    
    const availableCrews = crews.map(row => transformRow(row, 'crews'));
    
    res.json({
      success: true,
      data: availableCrews
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/employees/unassigned - Get employees not in any crew
apiRouter.get('/employees/unassigned', async (req, res) => {
  try {
    const query = `
      SELECT e.*
      FROM employees e
      LEFT JOIN crew_members cm ON e.id = cm.employee_id AND cm.left_at IS NULL
      WHERE cm.id IS NULL
      ORDER BY e.name
    `;
    
    const { rows } = await db.query(query);
    const employees = rows.map(row => transformRow(row, 'employees'));
    
    res.json({
      success: true,
      data: employees
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------
// CREW CRUD ENDPOINTS
// ----------------------

// GET /api/crews - List all crews with member counts
apiRouter.get('/crews', async (req, res) => {
  try {
    const includeDeleted = req.query.include_deleted === 'true';
    
    let query = `
      SELECT 
        c.*,
        COUNT(DISTINCT cm.id) FILTER (WHERE cm.left_at IS NULL) as member_count,
        COUNT(DISTINCT ca.id) as active_assignments
      FROM crews c
      LEFT JOIN crew_members cm ON c.id = cm.crew_id AND cm.left_at IS NULL
      LEFT JOIN crew_assignments ca ON c.id = ca.crew_id
      ${includeDeleted ? '' : 'WHERE c.deleted_at IS NULL'}
      GROUP BY c.id
      ORDER BY c.name
    `;
    
    const { rows } = await db.query(query);
    const crews = rows.map(row => transformRow(row, 'crews'));
    
    res.json({
      success: true,
      data: crews
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/crews/:id - Get crew by ID with members and assignments
apiRouter.get('/crews/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get crew basic info
    const crewQuery = `
      SELECT 
        c.*,
        COUNT(DISTINCT cm.id) FILTER (WHERE cm.left_at IS NULL) as member_count
      FROM crews c
      LEFT JOIN crew_members cm ON c.id = cm.crew_id AND cm.left_at IS NULL
      WHERE c.id = $1
      GROUP BY c.id
    `;
    const { rows: crewRows } = await db.query(crewQuery, [id]);
    
    if (crewRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew not found'
      });
    }
    
    const crew = transformRow(crewRows[0], 'crews');
    
    // Get crew members with employee details
    const membersQuery = `
      SELECT 
        cm.*,
        e.name as employee_name,
        e.phone,
        e.job_title,
        e.certifications
      FROM crew_members cm
      JOIN employees e ON cm.employee_id = e.id
      WHERE cm.crew_id = $1 AND cm.left_at IS NULL
      ORDER BY cm.role, e.name
    `;
    const { rows: memberRows } = await db.query(membersQuery, [id]);
    crew.members = memberRows.map(row => transformRow(row, 'crew_members'));
    
    // Get current job assignments
    const assignmentsQuery = `
      SELECT 
        ca.*,
        j.customer_name,
        j.status,
        j.scheduled_date,
        j.job_location
      FROM crew_assignments ca
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.crew_id = $1
      ORDER BY ca.assigned_date DESC
      LIMIT 10
    `;
    const { rows: assignmentRows } = await db.query(assignmentsQuery, [id]);
    crew.currentAssignments = assignmentRows.map(row => transformRow(row, 'crew_assignments'));
    
    res.json({
      success: true,
      data: crew
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/crews - Create new crew
apiRouter.post('/crews', async (req, res) => {
  try {
    const { name, description, default_start_time, default_end_time, capacity } = req.body;
    
    // Validation
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Crew name is required'
      });
    }
    
    if (capacity !== undefined && capacity <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Capacity must be greater than 0'
      });
    }
    
    const query = `
      INSERT INTO crews (name, description, default_start_time, default_end_time, capacity)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [
      name,
      description || null,
      default_start_time || null,
      default_end_time || null,
      capacity || null
    ]);
    
    const crew = transformRow(rows[0], 'crews');
    
    res.status(201).json({
      success: true,
      data: crew,
      message: 'Crew created successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/crews/:id - Update crew
apiRouter.put('/crews/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, is_active, default_start_time, default_end_time, capacity } = req.body;
    
    // Check if crew exists
    const checkQuery = 'SELECT id FROM crews WHERE id = $1';
    const { rows: checkRows } = await db.query(checkQuery, [id]);
    
    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew not found'
      });
    }
    
    // Validation
    if (capacity !== undefined && capacity <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Capacity must be greater than 0'
      });
    }
    
    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(is_active);
    }
    if (default_start_time !== undefined) {
      updates.push(`default_start_time = $${paramCount++}`);
      values.push(default_start_time);
    }
    if (default_end_time !== undefined) {
      updates.push(`default_end_time = $${paramCount++}`);
      values.push(default_end_time);
    }
    if (capacity !== undefined) {
      updates.push(`capacity = $${paramCount++}`);
      values.push(capacity);
    }
    
    updates.push(`updated_at = NOW()`);
    values.push(id);
    
    const query = `
      UPDATE crews
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;
    
    const { rows } = await db.query(query, values);
    const crew = transformRow(rows[0], 'crews');
    
    res.json({
      success: true,
      data: crew,
      message: 'Crew updated successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/crews/:id - Soft delete crew
apiRouter.delete('/crews/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if crew has active assignments
    const assignmentQuery = `
      SELECT COUNT(*) as count
      FROM crew_assignments ca
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.crew_id = $1 AND j.status NOT IN ('completed', 'cancelled')
    `;
    const { rows: assignmentRows } = await db.query(assignmentQuery, [id]);
    
    if (parseInt(assignmentRows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete crew with active job assignments'
      });
    }
    
    // Soft delete the crew
    const query = `
      UPDATE crews
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew not found or already deleted'
      });
    }
    
    res.json({
      success: true,
      message: 'Crew deleted successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------
// CREW MEMBER ENDPOINTS
// ----------------------

// POST /api/crews/:id/members - Add member to crew
apiRouter.post('/crews/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    const { employee_id, role } = req.body;
    
    // Validation
    if (!employee_id) {
      return res.status(400).json({
        success: false,
        error: 'employee_id is required'
      });
    }
    
    const validRoles = ['leader', 'climber', 'groundsman', 'driver'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        error: `Role must be one of: ${validRoles.join(', ')}`
      });
    }
    
    // Check if crew exists
    const crewQuery = 'SELECT id FROM crews WHERE id = $1 AND deleted_at IS NULL';
    const { rows: crewRows } = await db.query(crewQuery, [id]);
    
    if (crewRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew not found'
      });
    }
    
    // Check if employee exists
    const employeeQuery = 'SELECT id FROM employees WHERE id = $1';
    const { rows: employeeRows } = await db.query(employeeQuery, [employee_id]);
    
    if (employeeRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
    }
    
    // Check if employee is already an active member
    const memberCheckQuery = `
      SELECT id FROM crew_members
      WHERE crew_id = $1 AND employee_id = $2 AND left_at IS NULL
    `;
    const { rows: existingRows } = await db.query(memberCheckQuery, [id, employee_id]);
    
    if (existingRows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Employee is already an active member of this crew'
      });
    }
    
    // Add member to crew
    const insertQuery = `
      INSERT INTO crew_members (crew_id, employee_id, role)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    
    const { rows } = await db.query(insertQuery, [id, employee_id, role || null]);
    const member = transformRow(rows[0], 'crew_members');
    
    res.status(201).json({
      success: true,
      data: member,
      message: 'Member added to crew successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/crews/:id/members - Get all crew members
apiRouter.get('/crews/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if crew exists
    const crewQuery = 'SELECT id FROM crews WHERE id = $1';
    const { rows: crewRows } = await db.query(crewQuery, [id]);
    
    if (crewRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew not found'
      });
    }
    
    // Get active members with employee details
    const query = `
      SELECT 
        cm.*,
        e.name as employee_name,
        e.phone,
        e.job_title,
        e.certifications
      FROM crew_members cm
      JOIN employees e ON cm.employee_id = e.id
      WHERE cm.crew_id = $1 AND cm.left_at IS NULL
      ORDER BY 
        CASE cm.role
          WHEN 'leader' THEN 1
          WHEN 'climber' THEN 2
          WHEN 'groundsman' THEN 3
          WHEN 'driver' THEN 4
          ELSE 5
        END,
        e.name
    `;
    
    const { rows } = await db.query(query, [id]);
    const members = rows.map(row => transformRow(row, 'crew_members'));
    
    res.json({
      success: true,
      data: members
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/crews/:crew_id/members/:member_id - Update member role
apiRouter.put('/crews/:crew_id/members/:member_id', async (req, res) => {
  try {
    const { crew_id, member_id } = req.params;
    const { role } = req.body;
    
    // Validation
    const validRoles = ['leader', 'climber', 'groundsman', 'driver'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        error: `Role must be one of: ${validRoles.join(', ')}`
      });
    }
    
    // Update member role
    const query = `
      UPDATE crew_members
      SET role = $1
      WHERE id = $2 AND crew_id = $3 AND left_at IS NULL
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [role || null, member_id, crew_id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew member not found or no longer active'
      });
    }
    
    const member = transformRow(rows[0], 'crew_members');
    
    res.json({
      success: true,
      data: member,
      message: 'Member role updated successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/crews/:crew_id/members/:member_id - Remove member from crew
apiRouter.delete('/crews/:crew_id/members/:member_id', async (req, res) => {
  try {
    const { crew_id, member_id } = req.params;
    
    // Set left_at timestamp
    const query = `
      UPDATE crew_members
      SET left_at = NOW()
      WHERE id = $1 AND crew_id = $2 AND left_at IS NULL
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [member_id, crew_id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew member not found or already removed'
      });
    }
    
    res.json({
      success: true,
      message: 'Member removed from crew successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------
// CREW ASSIGNMENT ENDPOINTS
// ----------------------

// POST /api/jobs/:job_id/assign-crew - Assign crew to job
apiRouter.post('/jobs/:job_id/assign-crew', async (req, res) => {
  try {
    const { job_id } = req.params;
    const { crew_id, assigned_date, notes } = req.body;
    
    // Validation
    if (!crew_id) {
      return res.status(400).json({
        success: false,
        error: 'crew_id is required'
      });
    }
    
    if (!assigned_date) {
      return res.status(400).json({
        success: false,
        error: 'assigned_date is required'
      });
    }
    
    // Check if job exists
    const jobQuery = 'SELECT id FROM jobs WHERE id = $1';
    const { rows: jobRows } = await db.query(jobQuery, [job_id]);
    
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    // Check if crew exists and is active
    const crewQuery = 'SELECT id FROM crews WHERE id = $1 AND deleted_at IS NULL AND is_active = true';
    const { rows: crewRows } = await db.query(crewQuery, [crew_id]);
    
    if (crewRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew not found or inactive'
      });
    }
    
    // Create assignment
    const insertQuery = `
      INSERT INTO crew_assignments (job_id, crew_id, assigned_date, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    
    const { rows } = await db.query(insertQuery, [job_id, crew_id, assigned_date, notes || null]);
    const assignment = transformRow(rows[0], 'crew_assignments');
    
    res.status(201).json({
      success: true,
      data: assignment,
      message: 'Crew assigned to job successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/crews/:id/assignments - Get crew's assignments
apiRouter.get('/crews/:id/assignments', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;
    
    // Check if crew exists
    const crewQuery = 'SELECT id FROM crews WHERE id = $1';
    const { rows: crewRows } = await db.query(crewQuery, [id]);
    
    if (crewRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew not found'
      });
    }
    
    // Build query with optional date filters
    let query = `
      SELECT 
        ca.*,
        j.customer_name,
        j.status,
        j.scheduled_date,
        j.job_location,
        j.special_instructions as job_description
      FROM crew_assignments ca
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.crew_id = $1
    `;
    
    const params = [id];
    let paramCount = 2;
    
    if (start_date) {
      query += ` AND ca.assigned_date >= $${paramCount++}`;
      params.push(start_date);
    }
    
    if (end_date) {
      query += ` AND ca.assigned_date <= $${paramCount++}`;
      params.push(end_date);
    }
    
    query += ` ORDER BY ca.assigned_date DESC`;
    
    const { rows } = await db.query(query, params);
    const assignments = rows.map(row => transformRow(row, 'crew_assignments'));
    
    res.json({
      success: true,
      data: assignments
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/crew-assignments/:id - Remove crew assignment
apiRouter.delete('/crew-assignments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Hard delete the assignment
    const query = 'DELETE FROM crew_assignments WHERE id = $1 RETURNING *';
    const { rows } = await db.query(query, [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Crew assignment not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Crew assignment removed successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/crew-assignments/schedule - Get all crew assignments in a date range (for calendar)
apiRouter.get('/crew-assignments/schedule', async (req, res) => {
  try {
    const { start_date, end_date, crew_id } = req.query;
    
    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: 'start_date and end_date are required'
      });
    }
    
    let query = `
      SELECT 
        ca.*,
        c.name as crew_name,
        j.id as job_id,
        j.customer_name as job_title,
        j.customer_name,
        j.status as job_status,
        j.scheduled_date,
        j.job_location,
        j.special_instructions
      FROM crew_assignments ca
      JOIN crews c ON ca.crew_id = c.id
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.assigned_date >= $1 AND ca.assigned_date <= $2
        AND c.deleted_at IS NULL
    `;
    
    const params = [start_date, end_date];
    let paramCount = 3;
    
    if (crew_id) {
      query += ` AND ca.crew_id = $${paramCount}`;
      params.push(crew_id);
      paramCount++;
    }
    
    query += ' ORDER BY ca.assigned_date, c.name';
    
    const { rows } = await db.query(query, params);
    
    const assignments = rows.map(row => ({
      ...transformRow(row, 'crew_assignments'),
      crewName: row.crew_name,
      jobTitle: row.job_title,
      clientName: row.customer_name,
      jobStatus: row.job_status,
      scheduledDate: row.scheduled_date,
      jobLocation: row.job_location,
      specialInstructions: row.special_instructions
    }));
    
    res.json({
      success: true,
      data: assignments
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/crew-assignments/check-conflicts - Check for scheduling conflicts
apiRouter.post('/crew-assignments/check-conflicts', async (req, res) => {
  try {
    const { crew_id, assigned_date, job_id } = req.body;
    
    if (!crew_id || !assigned_date) {
      return res.status(400).json({
        success: false,
        error: 'crew_id and assigned_date are required'
      });
    }
    
    let query = `
      SELECT 
        ca.*,
        j.customer_name as job_title,
        j.customer_name,
        j.job_location
      FROM crew_assignments ca
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.crew_id = $1 AND ca.assigned_date = $2
    `;
    
    const params = [crew_id, assigned_date];
    
    // Exclude the current job if provided (for editing existing assignments)
    if (job_id) {
      query += ' AND ca.job_id != $3';
      params.push(job_id);
    }
    
    const { rows } = await db.query(query, params);
    
    const hasConflict = rows.length > 0;
    const conflicts = rows.map(row => ({
      assignmentId: row.id,
      jobTitle: row.job_title,
      clientName: row.client_name,
      jobLocation: row.job_location,
      assignedDate: row.assigned_date
    }));
    
    res.json({
      success: true,
      hasConflict,
      conflicts
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/crew-assignments/bulk-assign - Bulk assign crew to multiple dates
apiRouter.post('/crew-assignments/bulk-assign', async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { crew_id, job_id, dates, notes } = req.body;
    
    if (!crew_id || !job_id || !dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'crew_id, job_id, and dates array are required'
      });
    }
    
    // Start transaction
    await client.query('BEGIN');
    
    // Check if crew and job exist
    const [crewCheck, jobCheck] = await Promise.all([
      client.query('SELECT id FROM crews WHERE id = $1 AND deleted_at IS NULL', [crew_id]),
      client.query('SELECT id FROM jobs WHERE id = $1', [job_id])
    ]);
    
    if (crewCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Crew not found'
      });
    }
    
    if (jobCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }
    
    // Check for conflicts before inserting
    for (const date of dates) {
      const conflictCheck = await client.query(
        'SELECT id FROM crew_assignments WHERE crew_id = $1 AND assigned_date = $2 AND job_id != $3',
        [crew_id, date, job_id]
      );
      
      if (conflictCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: `Crew is already assigned on ${date}`
        });
      }
    }
    
    // Insert all assignments in a single batch operation
    const values = dates.map((date, idx) => {
      const offset = idx * 4;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    }).join(', ');
    
    const params = dates.flatMap(date => [job_id, crew_id, date, notes || null]);
    
    const insertQuery = `
      INSERT INTO crew_assignments (job_id, crew_id, assigned_date, notes)
      VALUES ${values}
      RETURNING *
    `;
    
    const { rows } = await client.query(insertQuery, params);
    
    // Commit transaction
    await client.query('COMMIT');
    
    const assignments = rows.map(row => transformRow(row, 'crew_assignments'));
    
    res.status(201).json({
      success: true,
      data: assignments,
      message: `Successfully created ${assignments.length} crew assignments`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    handleError(res, err);
  } finally {
    client.release();
  }
});

// PUT /api/crew-assignments/:id/reassign - Reassign to different crew or date
apiRouter.put('/crew-assignments/:id/reassign', async (req, res) => {
  try {
    const { id } = req.params;
    const { crew_id, assigned_date, notes } = req.body;
    
    if (!crew_id && !assigned_date) {
      return res.status(400).json({
        success: false,
        error: 'Either crew_id or assigned_date must be provided'
      });
    }
    
    // Get existing assignment
    const existingQuery = 'SELECT * FROM crew_assignments WHERE id = $1';
    const { rows: existingRows } = await db.query(existingQuery, [id]);
    
    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Assignment not found'
      });
    }
    
    const existing = existingRows[0];
    
    // Build update query
    const updates = [];
    const params = [];
    let paramCount = 1;
    
    if (crew_id) {
      // Verify new crew exists
      const crewCheck = await db.query(
        'SELECT id FROM crews WHERE id = $1 AND deleted_at IS NULL',
        [crew_id]
      );
      if (crewCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'New crew not found'
        });
      }
      updates.push(`crew_id = $${paramCount++}`);
      params.push(crew_id);
    }
    
    if (assigned_date) {
      updates.push(`assigned_date = $${paramCount++}`);
      params.push(assigned_date);
    }
    
    if (notes !== undefined) {
      updates.push(`notes = $${paramCount++}`);
      params.push(notes);
    }
    
    params.push(id);
    
    const query = `
      UPDATE crew_assignments 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;
    
    const { rows } = await db.query(query, params);
    
    res.json({
      success: true,
      data: transformRow(rows[0], 'crew_assignments'),
      message: 'Assignment reassigned successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// OPERATIONS INTELLIGENCE ENDPOINTS
// ============================================================================

// POST /api/operations/route-optimize - Compute optimal route for a crew/day
apiRouter.post('/operations/route-optimize', async (req, res) => {
  try {
    const { date, crewId, startLocation, includeInProgress } = req.body || {};
    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'date is required in YYYY-MM-DD format'
      });
    }

    const result = await operationsService.optimizeCrewRoute({
      date,
      crewId,
      startLocation,
      includeInProgress: includeInProgress !== false
    });

    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/operations/availability - Crew availability summaries
apiRouter.get('/operations/availability', async (req, res) => {
  try {
    const { start_date, end_date, crew_id } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: 'start_date and end_date query parameters are required'
      });
    }

    const data = await operationsService.getCrewAvailability({
      startDate: start_date,
      endDate: end_date
    });

    const filtered = crew_id ? data.filter(item => item.crewId === crew_id) : data;

    res.json({ success: true, data: filtered });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/operations/weather-impacts - Weather insights for scheduled jobs
apiRouter.get('/operations/weather-impacts', async (req, res) => {
  try {
    const { start_date, end_date, crew_id } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: 'start_date and end_date query parameters are required'
      });
    }

    const data = await operationsService.generateWeatherInsights({
      startDate: start_date,
      endDate: end_date,
      crewId: crew_id
    });

    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/operations/dispatch-messages - Prepare crew dispatch digest
apiRouter.post('/operations/dispatch-messages', async (req, res) => {
  try {
    const { date, crewId, channel } = req.body || {};
    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'date is required in YYYY-MM-DD format'
      });
    }

    const result = await operationsService.dispatchCrewDigest({
      date,
      crewId,
      channel: channel || 'sms'
    });

    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// RECURRING JOB SERIES ENDPOINTS
// ============================================================================

apiRouter.get('/job-series', async (req, res) => {
  try {
    const data = await recurringJobsService.listSeries();
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.get('/job-series/:id', async (req, res) => {
  try {
    const data = await recurringJobsService.getSeriesById(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.post('/job-series', async (req, res) => {
  try {
    const created = await recurringJobsService.createSeries(req.body || {});
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.put('/job-series/:id', async (req, res) => {
  try {
    const updated = await recurringJobsService.updateSeries(req.params.id, req.body || {});
    res.json({ success: true, data: updated });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.delete('/job-series/:id', async (req, res) => {
  try {
    await recurringJobsService.removeSeries(req.params.id);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.get('/job-series/:id/instances', async (req, res) => {
  try {
    const instances = await recurringJobsService.listInstances(req.params.id);
    res.json({ success: true, data: instances });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.post('/job-series/:id/generate', async (req, res) => {
  try {
    const instances = await recurringJobsService.generateInstances(req.params.id, req.body || {});
    res.json({ success: true, data: instances });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.post('/job-series/:id/instances/:instanceId/convert', async (req, res) => {
  try {
    const { job, instance } = await recurringJobsService.convertInstanceToJob(req.params.id, req.params.instanceId);
    res.status(201).json({
      success: true,
      data: {
        job: transformRow(job, 'jobs'),
        instance: transformRow(instance, 'recurring_job_instances')
      }
    });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.put('/job-series/:id/instances/:instanceId/status', async (req, res) => {
  try {
    const updated = await recurringJobsService.updateInstanceStatus(req.params.id, req.params.instanceId, req.body?.status);
    res.json({ success: true, data: updated });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// INVOICE MANAGEMENT ENDPOINTS (Phase 3A)
// ============================================================================

// Helper function to generate invoice number: INV-YYYY-####
const generateInvoiceNumber = async () => {
  const currentYear = new Date().getFullYear();
  const prefix = `INV-${currentYear}-`;
  
  // Query for the highest invoice number for the current year
  const query = `
    SELECT invoice_number 
    FROM invoices 
    WHERE invoice_number LIKE $1
    ORDER BY invoice_number DESC 
    LIMIT 1
  `;
  
  const { rows } = await db.query(query, [`${prefix}%`]);
  
  let nextNumber = 1;
  if (rows.length > 0) {
    // Extract the number part and increment
    const lastNumber = rows[0].invoice_number.split('-')[2];
    nextNumber = parseInt(lastNumber, 10) + 1;
  }
  
  // Format with leading zeros (4 digits)
  const invoiceNumber = `${prefix}${String(nextNumber).padStart(4, '0')}`;
  return invoiceNumber;
};

// Helper function to calculate invoice totals
const calculateInvoiceTotals = (lineItems, discountAmount = 0, discountPercentage = 0, taxRate = 0) => {
  // Calculate subtotal from line items
  const subtotal = lineItems.reduce((sum, item) => {
    const price = parseFloat(item.price) || 0;
    return sum + price;
  }, 0);
  
  // Apply discount
  let totalDiscount = parseFloat(discountAmount) || 0;
  if (discountPercentage > 0) {
    totalDiscount = subtotal * (parseFloat(discountPercentage) / 100);
  }
  
  const totalAmount = subtotal - totalDiscount;
  
  // Calculate tax
  const taxAmount = totalAmount * (parseFloat(taxRate) / 100);
  
  // Calculate grand total
  const grandTotal = totalAmount + taxAmount;
  
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    discountAmount: parseFloat(totalDiscount.toFixed(2)),
    discountPercentage: parseFloat(discountPercentage) || 0,
    taxRate: parseFloat(taxRate) || 0,
    taxAmount: parseFloat(taxAmount.toFixed(2)),
    totalAmount: parseFloat(totalAmount.toFixed(2)),
    grandTotal: parseFloat(grandTotal.toFixed(2))
  };
};

// POST /api/quotes/:id/convert-to-invoice - Generate invoice from a quote
apiRouter.post('/quotes/:id/convert-to-invoice', async (req, res) => {
  const { id } = req.params;
  const sanitizedId = sanitizeUUID(id);

  if (!sanitizedId) {
    return res.status(400).json({ success: false, error: 'Invalid quote ID' });
  }

  await db.query('BEGIN');

  try {
    const { rows: quoteRows } = await db.query(
      'SELECT * FROM quotes WHERE id = $1 AND deleted_at IS NULL',
      [sanitizedId]
    );

    if (quoteRows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Quote not found' });
    }

    const { rows: existingInvoices } = await db.query(
      'SELECT id, invoice_number FROM invoices WHERE quote_id = $1 LIMIT 1',
      [sanitizedId]
    );

    if (existingInvoices.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Quote already converted to invoice ${existingInvoices[0].invoice_number || existingInvoices[0].id}`
      });
    }

    const quote = quoteRows[0];
    const allowedStatuses = ['Sent', 'Accepted'];

    if (!allowedStatuses.includes(quote.status)) {
      await db.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Cannot convert quote with status '${quote.status}' to invoice. Quote must be 'Sent' or 'Accepted'.`
      });
    }

    const selectedLineItems = Array.isArray(quote.line_items)
      ? quote.line_items.filter(item => item.selected !== false)
      : [];

    if (selectedLineItems.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Quote has no selected line items to invoice'
      });
    }

    const totals = calculateInvoiceTotals(
      selectedLineItems,
      quote.discount_amount || 0,
      quote.discount_percentage || 0,
      quote.tax_rate || 0
    );

    const invoiceId = uuidv4();
    const invoiceNumber = await generateInvoiceNumber();
    const issueDate = new Date().toISOString().split('T')[0];
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const paymentTerms = quote.payment_terms || 'Net 30';

    let clientEmail = null;
    let clientPhone = null;
    let clientAddress = null;

    if (quote.client_id) {
      const { rows: clients } = await db.query(
        `SELECT primary_email, primary_phone, billing_address_line1, billing_address_line2, 
                billing_city, billing_state, billing_zip_code 
         FROM clients WHERE id = $1`,
        [quote.client_id]
      );
      
      if (clients.length > 0) {
        const client = clients[0];
        clientEmail = client.primary_email;
        clientPhone = client.primary_phone;
        
        const addressParts = [
          client.billing_address_line1,
          client.billing_address_line2,
          client.billing_city,
          client.billing_state,
          client.billing_zip_code
        ].filter(Boolean);
        clientAddress = addressParts.join(', ');
      }
    }

    const insertInvoiceQuery = `
      INSERT INTO invoices (
        id, quote_id, job_id, client_id, property_id, customer_name, status,
        invoice_number, issue_date, due_date,
        line_items, subtotal, discount_amount, discount_percentage,
        tax_rate, tax_amount, total_amount, grand_total,
        amount_paid, amount_due, payment_terms,
        customer_email, customer_phone, customer_address,
        notes, customer_notes, amount
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27
      )
      RETURNING *
    `;

    const insertValues = [
      invoiceId,
      sanitizedId,
      quote.job_id || null,
      quote.client_id || null,
      quote.property_id || null,
      quote.customer_name,
      'Draft',
      invoiceNumber,
      issueDate,
      dueDate,
      JSON.stringify(selectedLineItems),
      totals.subtotal,
      totals.discountAmount,
      totals.discountPercentage,
      totals.taxRate,
      totals.taxAmount,
      totals.totalAmount,
      totals.grandTotal,
      0,
      totals.grandTotal,
      paymentTerms,
      clientEmail || quote.customer_email || null,
      clientPhone || quote.customer_phone || null,
      clientAddress || quote.job_location || null,
      quote.terms_and_conditions || null,
      quote.special_instructions || null,
      totals.grandTotal
    ];

    const { rows: invoiceRows } = await db.query(insertInvoiceQuery, insertValues);

    const updateQuoteQuery = `
      UPDATE quotes
      SET status = 'Invoiced', updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;

    const { rows: updatedQuoteRows } = await db.query(updateQuoteQuery, [sanitizedId]);

    await db.query('COMMIT');

    const invoice = transformRow(invoiceRows[0], 'invoices');
    const updatedQuote = snakeToCamel(updatedQuoteRows[0]);

    reminderService.scheduleInvoiceReminders(invoiceRows[0]);

    // Emit invoice_created event
    try {
      await emitBusinessEvent('invoice_created', {
        id: invoice.id,
        ...invoice
      });
    } catch (e) {
      console.error('[Automation] Failed to emit invoice_created:', e.message);
    }

    return res.status(201).json({
      success: true,
      data: { invoice, quote: updatedQuote },
      message: `Invoice ${invoiceNumber} created from quote`
    });
  } catch (err) {
    await db.query('ROLLBACK');
    handleError(res, err);
  }
});

// POST /api/invoices - Create new invoice with auto-generated invoice_number
apiRouter.post('/invoices', async (req, res) => {
  try {
    const invoiceData = req.body;
    
    // Validate required fields
    if (!invoiceData.customerName) {
      return res.status(400).json({
        success: false,
        error: 'customerName is required'
      });
    }
    
    if (!invoiceData.lineItems || !Array.isArray(invoiceData.lineItems) || invoiceData.lineItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'lineItems is required and must be a non-empty array'
      });
    }
    
    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber();
    
    // Calculate totals
    const totals = calculateInvoiceTotals(
      invoiceData.lineItems,
      invoiceData.discountAmount || 0,
      invoiceData.discountPercentage || 0,
      invoiceData.taxRate || 0
    );
    
    // Prepare invoice data
    const id = uuidv4();
    const status = invoiceData.status || 'Draft';
    const issueDate = invoiceData.issueDate || new Date().toISOString().split('T')[0];
    const dueDate = invoiceData.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const paymentTerms = invoiceData.paymentTerms || 'Net 30';
    
    // For backward compatibility, set amount field
    const amount = totals.grandTotal;
    
    // Calculate amount_due (grand_total - amount_paid)
    const amountPaid = 0;
    const amountDue = totals.grandTotal;
    
    const billingType = invoiceData.billingType || 'single';
    const parentInvoiceId = invoiceData.parentInvoiceId || null;
    const paymentSchedule = invoiceData.paymentSchedule || [];
    const billingSequence = invoiceData.billingSequence || 1;
    const contractTotal = invoiceData.contractTotal || totals.grandTotal;

    const query = `
      INSERT INTO invoices (
        id, quote_id, job_id, client_id, property_id, customer_name, status,
        invoice_number, issue_date, due_date,
        line_items, subtotal, discount_amount, discount_percentage,
        tax_rate, tax_amount, total_amount, grand_total,
        amount_paid, amount_due, payment_terms,
        customer_email, customer_phone, customer_address,
        notes, customer_notes, amount,
        billing_type, parent_invoice_id, payment_schedule, billing_sequence, contract_total
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27,
        $28, $29, $30, $31, $32
      )
      RETURNING *
    `;

    const values = [
      id,
      invoiceData.quoteId || null,
      invoiceData.jobId || null,
      invoiceData.clientId || null,
      invoiceData.propertyId || null,
      invoiceData.customerName,
      status,
      invoiceNumber,
      issueDate,
      dueDate,
      JSON.stringify(invoiceData.lineItems),
      totals.subtotal,
      totals.discountAmount,
      totals.discountPercentage,
      totals.taxRate,
      totals.taxAmount,
      totals.totalAmount,
      totals.grandTotal,
      amountPaid,
      amountDue,
      paymentTerms,
      invoiceData.customerEmail || null,
      invoiceData.customerPhone || null,
      invoiceData.customerAddress || null,
      invoiceData.notes || null,
      invoiceData.customerNotes || null,
      amount,
      billingType,
      parentInvoiceId,
      JSON.stringify(paymentSchedule),
      billingSequence,
      contractTotal
    ];
    
    const { rows } = await db.query(query, values);
    const result = transformRow(rows[0], 'invoices');

    reminderService.scheduleInvoiceReminders(rows[0]);

    // Emit invoice_created event
    try {
      await emitBusinessEvent('invoice_created', {
        id: result.id,
        ...result
      });
    } catch (e) {
      console.error('[Automation] Failed to emit invoice_created:', e.message);
    }

    res.status(201).json({
      success: true,
      data: result,
      message: `Invoice ${invoiceNumber} created successfully`
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/invoices/batch/candidates - Get completed jobs without invoices for batch invoicing
apiRouter.get('/invoices/batch/candidates', async (req, res) => {
  try {
    const query = `
      SELECT j.*, 
             c.company_name, c.first_name, c.last_name, c.primary_email, c.primary_phone,
             p.address as property_address, p.city as property_city, p.state as property_state
      FROM jobs j
      LEFT JOIN clients c ON j.client_id = c.id
      LEFT JOIN properties p ON j.property_id = p.id
      WHERE j.status = 'completed'
        AND j.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoices i WHERE i.job_id = j.id
        )
      ORDER BY j.updated_at DESC
    `;
    
    const { rows } = await db.query(query);
    
    const candidates = rows.map(row => {
      const job = transformRow(row, 'jobs');
      job.clientName = row.company_name || `${row.first_name || ''} ${row.last_name || ''}`.trim() || job.customerName || 'Unknown';
      job.clientEmail = row.primary_email;
      job.clientPhone = row.primary_phone;
      job.propertyAddress = [row.property_address, row.property_city, row.property_state].filter(Boolean).join(', ');
      return job;
    });
    
    res.json({
      success: true,
      data: candidates,
      count: candidates.length
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/invoices/batch - Create invoices for multiple completed jobs
apiRouter.post('/invoices/batch', async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { jobIds, paymentTerms = 'Net 30', taxRate = 0 } = req.body;
    
    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'jobIds is required and must be a non-empty array'
      });
    }
    
    await client.query('BEGIN');
    
    const createdInvoices = [];
    const errors = [];
    
    for (const jobId of jobIds) {
      try {
        const sanitizedJobId = sanitizeUUID(jobId);
        if (!sanitizedJobId) {
          errors.push({ jobId, error: 'Invalid job ID format' });
          continue;
        }
        
        // Get job with related data
        const jobQuery = `
          SELECT j.*, 
                 c.company_name, c.first_name, c.last_name, c.primary_email, c.primary_phone,
                 c.id as client_id,
                 p.address, p.city, p.state, p.zip
          FROM jobs j
          LEFT JOIN clients c ON j.client_id = c.id
          LEFT JOIN properties p ON j.property_id = p.id
          WHERE j.id = $1 AND j.status = 'completed' AND j.deleted_at IS NULL
        `;
        
        const { rows: jobRows } = await client.query(jobQuery, [sanitizedJobId]);
        
        if (jobRows.length === 0) {
          errors.push({ jobId, error: 'Job not found or not completed' });
          continue;
        }
        
        const job = jobRows[0];
        
        // Check if invoice already exists
        const existingInvoiceQuery = 'SELECT id FROM invoices WHERE job_id = $1';
        const { rows: existingInvoices } = await client.query(existingInvoiceQuery, [sanitizedJobId]);
        
        if (existingInvoices.length > 0) {
          errors.push({ jobId, error: 'Invoice already exists for this job' });
          continue;
        }
        
        // Build line items from job
        const lineItems = job.line_items || [];
        if (lineItems.length === 0) {
          // Create a single line item from job total
          lineItems.push({
            description: job.description || `Services for Job #${job.job_number || job.id.slice(0, 8)}`,
            quantity: 1,
            unitPrice: parseFloat(job.total_amount) || 0,
            price: parseFloat(job.total_amount) || 0,
            selected: true
          });
        }
        
        // Calculate totals
        const totals = calculateInvoiceTotals(lineItems, 0, 0, taxRate);
        
        // Generate invoice number
        const invoiceNumber = await generateInvoiceNumber();
        
        // Customer info
        const customerName = job.company_name || `${job.first_name || ''} ${job.last_name || ''}`.trim() || job.customer_name || 'Unknown';
        const customerAddress = [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ');
        
        const invoiceId = uuidv4();
        const issueDate = new Date().toISOString().split('T')[0];
        const dueDays = paymentTerms === 'Due on Receipt' ? 0 : parseInt(paymentTerms.replace('Net ', '')) || 30;
        const dueDate = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const insertQuery = `
          INSERT INTO invoices (
            id, job_id, client_id, property_id, customer_name, status,
            invoice_number, issue_date, due_date,
            line_items, subtotal, discount_amount, discount_percentage,
            tax_rate, tax_amount, total_amount, grand_total,
            amount_paid, amount_due, payment_terms,
            customer_email, customer_phone, customer_address, amount,
            billing_type, billing_sequence, contract_total
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20,
            $21, $22, $23, $24,
            $25, $26, $27
          )
          RETURNING *
        `;
        
        const insertValues = [
          invoiceId,
          sanitizedJobId,
          job.client_id || null,
          job.property_id || null,
          customerName,
          'Draft',
          invoiceNumber,
          issueDate,
          dueDate,
          JSON.stringify(lineItems),
          totals.subtotal,
          0,
          0,
          taxRate,
          totals.taxAmount,
          totals.totalAmount,
          totals.grandTotal,
          0,
          totals.grandTotal,
          paymentTerms,
          job.primary_email || null,
          job.primary_phone || null,
          customerAddress || null,
          totals.grandTotal,
          'single',
          1,
          totals.grandTotal
        ];
        
        const { rows: invoiceRows } = await client.query(insertQuery, insertValues);
        const invoice = transformRow(invoiceRows[0], 'invoices');
        createdInvoices.push(invoice);
        
        // Schedule reminders
        reminderService.scheduleInvoiceReminders(invoiceRows[0]);
        
      } catch (jobError) {
        errors.push({ jobId, error: jobError.message });
      }
    }
    
    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      data: {
        created: createdInvoices,
        errors: errors
      },
      message: `Created ${createdInvoices.length} invoice(s)${errors.length > 0 ? `, ${errors.length} failed` : ''}`
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    handleError(res, err);
  } finally {
    client.release();
  }
});

// GET /api/invoices - List invoices with filtering
apiRouter.get('/invoices', async (req, res) => {
  try {
    const { status, clientId, startDate, endDate, page = 1, limit = 50 } = req.query;
    
    let query = 'SELECT * FROM invoices WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (status) {
      query += ` AND status = $${paramCount++}`;
      params.push(status);
    }
    
    if (clientId) {
      query += ` AND client_id = $${paramCount++}`;
      params.push(clientId);
    }
    
    if (startDate) {
      query += ` AND issue_date >= $${paramCount++}`;
      params.push(startDate);
    }
    
    if (endDate) {
      query += ` AND issue_date <= $${paramCount++}`;
      params.push(endDate);
    }
    
    query += ' ORDER BY created_at DESC';
    
    // Add pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query += ` LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit), offset);
    
    const { rows } = await db.query(query, params);
    
    // Get payment records for each invoice
    const invoicesWithPayments = await Promise.all(rows.map(async (invoice) => {
      const paymentQuery = 'SELECT * FROM payment_records WHERE invoice_id = $1 ORDER BY payment_date DESC';
      const { rows: payments } = await db.query(paymentQuery, [invoice.id]);
      
      const transformed = transformRow(invoice, 'invoices');
      transformed.payments = payments.map(p => transformRow(p, 'payment_records'));
      
      return transformed;
    }));
    
    res.json({
      success: true,
      data: invoicesWithPayments
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/invoices/:id - Get single invoice with related data
apiRouter.get('/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get invoice
    const invoiceQuery = 'SELECT * FROM invoices WHERE id = $1';
    const { rows: invoiceRows } = await db.query(invoiceQuery, [id]);
    
    if (invoiceRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    const invoice = transformRow(invoiceRows[0], 'invoices');
    
    // Get payment records
    const paymentQuery = 'SELECT * FROM payment_records WHERE invoice_id = $1 ORDER BY payment_date DESC';
    const { rows: payments } = await db.query(paymentQuery, [id]);
    invoice.payments = payments.map(p => transformRow(p, 'payment_records'));
    
    // Optionally get related job, client, property
    if (invoice.jobId) {
      const jobQuery = 'SELECT * FROM jobs WHERE id = $1';
      const { rows: jobRows } = await db.query(jobQuery, [invoice.jobId]);
      if (jobRows.length > 0) {
        invoice.job = transformRow(jobRows[0], 'jobs');
      }
    }
    
    if (invoice.clientId) {
      const clientQuery = 'SELECT * FROM clients WHERE id = $1';
      const { rows: clientRows } = await db.query(clientQuery, [invoice.clientId]);
      if (clientRows.length > 0) {
        invoice.client = transformRow(clientRows[0], 'clients');
      }
    }
    
    res.json({
      success: true,
      data: invoice
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/invoices/:id - Update invoice with status management
apiRouter.put('/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Get current invoice
    const currentQuery = 'SELECT * FROM invoices WHERE id = $1';
    const { rows: currentRows } = await db.query(currentQuery, [id]);
    
    if (currentRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    const currentInvoice = currentRows[0];
    
    // Recalculate totals if lineItems or financial fields changed
    let totals = {};
    if (updates.lineItems || updates.discountAmount !== undefined || updates.discountPercentage !== undefined || updates.taxRate !== undefined) {
      const lineItems = updates.lineItems || currentInvoice.line_items;
      const discountAmount = updates.discountAmount !== undefined ? updates.discountAmount : currentInvoice.discount_amount;
      const discountPercentage = updates.discountPercentage !== undefined ? updates.discountPercentage : currentInvoice.discount_percentage;
      const taxRate = updates.taxRate !== undefined ? updates.taxRate : currentInvoice.tax_rate;
      
      totals = calculateInvoiceTotals(lineItems, discountAmount, discountPercentage, taxRate);
      
      // Update amount_due based on new grand_total
      totals.amountDue = totals.grandTotal - (currentInvoice.amount_paid || 0);
    }
    
    // Handle status transitions
    const newStatus = updates.status || currentInvoice.status;
    let sentDate = currentInvoice.sent_date;
    let paidAt = currentInvoice.paid_at;
    
    if (newStatus === 'Sent' && currentInvoice.status !== 'Sent' && !sentDate) {
      sentDate = new Date().toISOString();
    }
    
    if (newStatus === 'Paid' && currentInvoice.status !== 'Paid' && !paidAt) {
      paidAt = new Date().toISOString();
    }
    
    // Build update query
    const updateData = transformToDb(updates, 'invoices');
    
    // Override with calculated totals if they exist
    if (Object.keys(totals).length > 0) {
      updateData.subtotal = totals.subtotal;
      updateData.discount_amount = totals.discountAmount;
      updateData.discount_percentage = totals.discountPercentage;
      updateData.tax_rate = totals.taxRate;
      updateData.tax_amount = totals.taxAmount;
      updateData.total_amount = totals.totalAmount;
      updateData.grand_total = totals.grandTotal;
      updateData.amount_due = totals.amountDue;
      updateData.amount = totals.grandTotal; // For backward compatibility
    }
    
    // Override status transition dates
    if (updates.status) {
      updateData.status = newStatus;
    }
    if (sentDate && sentDate !== currentInvoice.sent_date) {
      updateData.sent_date = sentDate;
    }
    if (paidAt && paidAt !== currentInvoice.paid_at) {
      updateData.paid_at = paidAt;
    }
    
    updateData.updated_at = new Date().toISOString();
    
    // Remove undefined and id fields
    delete updateData.id;
    delete updateData.created_at;
    delete updateData.invoice_number; // Don't allow changing invoice number
    
    const columns = Object.keys(updateData).filter(key => updateData[key] !== undefined);
    const values = columns.map(key => updateData[key]);
    const setString = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
    
    const query = `UPDATE invoices SET ${setString} WHERE id = $1 RETURNING *`;
    const { rows } = await db.query(query, [id, ...values]);

    const result = transformRow(rows[0], 'invoices');

    if (result.status === 'Paid' || result.status === 'Void') {
      reminderService.cancelInvoiceReminders(id);
    } else {
      reminderService.scheduleInvoiceReminders(rows[0]);
    }

    // Emit invoice_sent event when status changes to 'Sent'
    if (newStatus === 'Sent' && currentInvoice.status !== 'Sent') {
      try {
        await emitBusinessEvent('invoice_sent', { id: currentInvoice.id, ...result });
      } catch (e) {
        console.error('[Automation] Failed to emit invoice_sent:', e.message);
      }
    }

    // Emit invoice_paid event when status changes to 'Paid'
    if (newStatus === 'Paid' && currentInvoice.status !== 'Paid') {
      try {
        await emitBusinessEvent('invoice_paid', { id: currentInvoice.id, ...result });
      } catch (e) {
        console.error('[Automation] Failed to emit invoice_paid:', e.message);
      }
    }

    res.json({
      success: true,
      data: result,
      message: 'Invoice updated successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/invoices/:id - Void/soft delete invoice
apiRouter.delete('/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if invoice exists
    const checkQuery = 'SELECT * FROM invoices WHERE id = $1';
    const { rows: checkRows } = await db.query(checkQuery, [id]);
    
    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Soft delete by setting status to 'Void'
    const query = `
      UPDATE invoices 
      SET status = 'Void', updated_at = NOW()
      WHERE id = $1 
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [id]);
    const result = transformRow(rows[0], 'invoices');
    
    res.json({
      success: true,
      data: result,
      message: 'Invoice voided successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/invoices/:id/payments - Record a payment against an invoice
apiRouter.post('/invoices/:id/payments', async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { id: invoiceId } = req.params;
    const { amount, paymentDate, paymentMethod, transactionId, referenceNumber, notes, recordedBy } = req.body;
    
    // Validate required fields
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'amount is required and must be greater than 0'
      });
    }
    
    if (!paymentMethod) {
      return res.status(400).json({
        success: false,
        error: 'paymentMethod is required'
      });
    }
    
    await client.query('BEGIN');
    
    // Get current invoice
    const invoiceQuery = 'SELECT * FROM invoices WHERE id = $1';
    const { rows: invoiceRows } = await client.query(invoiceQuery, [invoiceId]);
    
    if (invoiceRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    const invoice = invoiceRows[0];
    
    // Check if payment amount exceeds amount due
    const currentAmountDue = parseFloat(invoice.amount_due || invoice.grand_total || invoice.amount || 0);
    const paymentAmount = parseFloat(amount);
    
    if (paymentAmount > currentAmountDue) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Payment amount ($${paymentAmount}) exceeds amount due ($${currentAmountDue})`
      });
    }
    
    // Insert payment record
    const paymentId = uuidv4();
    const paymentInsertQuery = `
      INSERT INTO payment_records (
        id, invoice_id, amount, payment_date, payment_method,
        transaction_id, reference_number, notes, recorded_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    
    const paymentValues = [
      paymentId,
      invoiceId,
      paymentAmount,
      paymentDate || new Date().toISOString().split('T')[0],
      paymentMethod,
      transactionId || null,
      referenceNumber || null,
      notes || null,
      recordedBy || null
    ];
    
    const { rows: paymentRows } = await client.query(paymentInsertQuery, paymentValues);
    
    // Update invoice amounts
    const newAmountPaid = parseFloat(invoice.amount_paid || 0) + paymentAmount;
    const newAmountDue = currentAmountDue - paymentAmount;
    
    // Determine new status
    let newStatus = invoice.status;
    let paidAt = invoice.paid_at;
    
    if (newAmountDue <= 0.01) { // Account for floating point precision
      newStatus = 'Paid';
      paidAt = paidAt || new Date().toISOString();
    }
    
    // Update invoice
    const invoiceUpdateQuery = `
      UPDATE invoices 
      SET 
        amount_paid = $1,
        amount_due = $2,
        status = $3,
        paid_at = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `;
    
    const { rows: updatedInvoiceRows } = await client.query(invoiceUpdateQuery, [
      newAmountPaid,
      newAmountDue,
      newStatus,
      paidAt,
      invoiceId
    ]);
    
    await client.query('COMMIT');
    
    const payment = transformRow(paymentRows[0], 'payment_records');
    const updatedInvoice = transformRow(updatedInvoiceRows[0], 'invoices');
    
    res.status(201).json({
      success: true,
      data: {
        payment,
        invoice: updatedInvoice
      },
      message: `Payment of $${paymentAmount} recorded successfully`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    handleError(res, err);
  } finally {
    client.release();
  }
});

// GET /api/invoices/:id/payments - Get all payments for an invoice
apiRouter.get('/invoices/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if invoice exists
    const invoiceQuery = 'SELECT id FROM invoices WHERE id = $1';
    const { rows: invoiceRows } = await db.query(invoiceQuery, [id]);
    
    if (invoiceRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Get payment records
    const paymentQuery = 'SELECT * FROM payment_records WHERE invoice_id = $1 ORDER BY payment_date DESC, created_at DESC';
    const { rows } = await db.query(paymentQuery, [id]);
    
    const payments = rows.map(row => transformRow(row, 'payment_records'));
    
    res.json({
      success: true,
      data: payments
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/invoices/:id/create-checkout-session - Create Stripe checkout session for invoice payment
apiRouter.post('/invoices/:id/create-checkout-session', async (req, res) => {
  try {
    const { id: invoiceId } = req.params;
    
    const invoiceQuery = `
      SELECT i.*, c.id as client_id, c.primary_email, c.stripe_customer_id
      FROM invoices i
      LEFT JOIN clients c ON i.client_id = c.id
      WHERE i.id = $1
    `;
    const { rows: invoiceRows } = await db.query(invoiceQuery, [invoiceId]);
    
    if (invoiceRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    const invoice = invoiceRows[0];
    
    if (invoice.status === 'Paid') {
      return res.status(400).json({
        success: false,
        error: 'Invoice is already paid'
      });
    }
    
    const amountDue = parseFloat(invoice.amount_due || invoice.grand_total || invoice.amount || 0);
    
    if (amountDue <= 0) {
      return res.status(400).json({
        success: false,
        error: 'No amount due on this invoice'
      });
    }
    
    // DATA INTEGRITY: We do NOT persist the Stripe customer ID here at checkout session creation.
    // Instead, customer IDs are persisted exclusively in the webhook handler after payment succeeds.
    // This design choice prevents orphaned Stripe customer references if:
    // - The checkout session is created but the user never completes payment
    // - The checkout session fails or is cancelled
    // - There are network issues during checkout
    // The webhook handler receives verified events from Stripe only after successful payment,
    // ensuring our database only contains customer IDs for actual paying customers.
    let stripeCustomerId = invoice.stripe_customer_id;
    
    if (!stripeCustomerId && invoice.client_id && invoice.primary_email) {
      try {
        const customer = await stripeService.createCustomer(invoice.primary_email, invoice.client_id);
        stripeCustomerId = customer.id;
        console.log(`✅ Created Stripe customer ${stripeCustomerId} for client ${invoice.client_id}`);
        // NOTE: Customer ID will be persisted to database by webhook handler after successful payment
      } catch (err) {
        console.error(`❌ Failed to create Stripe customer for client ${invoice.client_id}:`, err.message);
        return res.status(500).json({
          success: false,
          error: 'Failed to create Stripe customer'
        });
      }
    }
    
    const baseUrl = req.protocol + '://' + req.get('host');
    const successUrl = `${baseUrl}/portal/invoices/${invoiceId}?payment=success`;
    const cancelUrl = `${baseUrl}/portal/invoices/${invoiceId}?payment=cancelled`;
    
    const session = await stripeService.createCheckoutSession(
      stripeCustomerId,
      invoiceId,
      amountDue,
      invoice.invoice_number || invoiceId,
      invoice.customer_email || invoice.primary_email,
      successUrl,
      cancelUrl
    );
    
    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        url: session.url
      }
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/invoices/:id/payment-link - Generate a reusable payment link for the invoice
apiRouter.post('/invoices/:id/payment-link', async (req, res) => {
  try {
    const { id: invoiceId } = req.params;

    const baseUrl = process.env.PUBLIC_BASE_URL || process.env.VERCEL_URL || process.env.REPLIT_APP_URL || `${req.protocol}://${req.get('host')}`;
    const successUrl = `${baseUrl}/invoice/${invoiceId}?status=paid`;
    const cancelUrl = `${baseUrl}/invoice/${invoiceId}`;

    const invoiceQuery = `
      SELECT i.*, c.id as client_id, c.primary_email, c.stripe_customer_id
      FROM invoices i
      LEFT JOIN clients c ON i.client_id = c.id
      WHERE i.id = $1
    `;

    const { rows: invoiceRows } = await db.query(invoiceQuery, [invoiceId]);

    if (invoiceRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    const invoice = invoiceRows[0];

    if (invoice.status === 'Paid') {
      return res.status(400).json({ success: false, error: 'Invoice is already paid' });
    }

    const amountDue = parseFloat(invoice.amount_due || invoice.grand_total || invoice.amount || 0);

    if (amountDue <= 0) {
      return res.status(400).json({ success: false, error: 'No amount due on this invoice' });
    }

    if (!stripeInitialized) {
      const fallbackLink = `${baseUrl}/invoice/${invoiceId}`;
      return res.json({
        success: true,
        paymentLink: fallbackLink,
        message: 'Stripe not configured; using portal link instead',
      });
    }

    const { url: paymentLink } = await stripeService.createCheckoutSession(
      invoice.stripe_customer_id,
      invoiceId,
      amountDue,
      invoice.invoice_number || invoiceId,
      invoice.customer_email || invoice.primary_email,
      successUrl,
      cancelUrl
    );

    res.json({ success: true, paymentLink });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// TIME TRACKING ENDPOINTS
// ============================================================================

// POST /api/time-entries/clock-in - Clock in for a job
apiRouter.post('/time-entries/clock-in', async (req, res) => {
  try {
    const { employeeId, jobId, location, notes } = req.body;
    
    if (!employeeId) {
      return res.status(400).json({
        success: false,
        error: 'employeeId is required'
      });
    }
    
    // Check if employee already has an active clock-in
    const activeCheck = await db.query(
      'SELECT id FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL AND status != $2',
      [employeeId, 'rejected']
    );
    
    if (activeCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Employee already has an active clock-in. Please clock out first.'
      });
    }
    
    const id = uuidv4();
    const clockIn = new Date();
    
    // Get employee hourly rate
    const empQuery = await db.query('SELECT hourly_rate FROM employees WHERE id = $1', [employeeId]);
    const hourlyRate = empQuery.rows[0]?.hourly_rate || 0;
    
    const query = `
      INSERT INTO time_entries (
        id, employee_id, job_id, clock_in, clock_in_location, 
        notes, status, hourly_rate
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [
      id,
      employeeId,
      jobId || null,
      clockIn,
      location ? JSON.stringify(location) : null,
      notes || null,
      'draft',
      hourlyRate
    ]);
    
    res.json({
      success: true,
      data: transformRow(rows[0], 'time_entries'),
      message: 'Clocked in successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/time-entries/:id/clock-out - Clock out from a time entry
apiRouter.post('/time-entries/:id/clock-out', async (req, res) => {
  try {
    const { id } = req.params;
    const { location, notes, breakMinutes } = req.body;
    
    // Get the existing entry
    const checkQuery = 'SELECT * FROM time_entries WHERE id = $1';
    const { rows: existingRows } = await db.query(checkQuery, [id]);
    
    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Time entry not found'
      });
    }
    
    const entry = existingRows[0];
    
    if (entry.clock_out) {
      return res.status(400).json({
        success: false,
        error: 'Already clocked out'
      });
    }
    
    const clockOut = new Date();
    const clockIn = new Date(entry.clock_in);
    
    // Calculate hours worked (excluding breaks)
    const totalMinutes = (clockOut - clockIn) / (1000 * 60);
    const workMinutes = totalMinutes - (breakMinutes || 0);
    const hoursWorked = Math.max(0, workMinutes / 60);
    const totalAmount = hoursWorked * (entry.hourly_rate || 0);
    
    const query = `
      UPDATE time_entries 
      SET 
        clock_out = $1,
        clock_out_location = $2,
        notes = COALESCE($3, notes),
        break_minutes = $4,
        hours_worked = $5,
        total_amount = $6,
        status = 'submitted'
      WHERE id = $7
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [
      clockOut,
      location ? JSON.stringify(location) : null,
      notes,
      breakMinutes || 0,
      hoursWorked,
      totalAmount,
      id
    ]);
    
    res.json({
      success: true,
      data: transformRow(rows[0], 'time_entries'),
      message: 'Clocked out successfully'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/time-entries - Get time entries with filters
apiRouter.get('/time-entries', async (req, res) => {
  try {
    const { employeeId, jobId, status, startDate, endDate, limit = 100 } = req.query;
    
    let query = `
      SELECT 
        te.*,
        e.name as employee_name,
        j.customer_name as job_title,
        j.customer_name as job_client_name
      FROM time_entries te
      LEFT JOIN employees e ON te.employee_id = e.id
      LEFT JOIN jobs j ON te.job_id = j.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (employeeId) {
      query += ` AND te.employee_id = $${paramCount}`;
      params.push(employeeId);
      paramCount++;
    }
    
    if (jobId) {
      query += ` AND te.job_id = $${paramCount}`;
      params.push(jobId);
      paramCount++;
    }
    
    if (status) {
      query += ` AND te.approval_status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }
    
    if (startDate) {
      query += ` AND te.clock_in_time >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }
    
    if (endDate) {
      query += ` AND te.clock_in_time <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }
    
    query += ` ORDER BY te.clock_in_time DESC LIMIT $${paramCount}`;
    params.push(parseInt(limit));
    
    const { rows } = await db.query(query, params);
    
    const entries = rows.map(row => {
      const entry = transformRow(row, 'time_entries');
      entry.employeeName = row.employee_name;
      entry.jobTitle = row.job_title;
      entry.jobClientName = row.job_client_name;
      return entry;
    });
    
    res.json({
      success: true,
      data: entries
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/time-entries/:id/approve - Approve a time entry
apiRouter.put('/time-entries/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approvedBy } = req.body;
    
    if (!approvedBy) {
      return res.status(400).json({
        success: false,
        error: 'approvedBy is required'
      });
    }
    
    const query = `
      UPDATE time_entries 
      SET 
        status = 'approved',
        approved_by = $1,
        approved_at = NOW()
      WHERE id = $2
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [approvedBy, id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Time entry not found'
      });
    }
    
    res.json({
      success: true,
      data: transformRow(rows[0], 'time_entries'),
      message: 'Time entry approved'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/time-entries/:id/reject - Reject a time entry
apiRouter.put('/time-entries/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { approvedBy, rejectionReason } = req.body;
    
    if (!approvedBy) {
      return res.status(400).json({
        success: false,
        error: 'approvedBy is required'
      });
    }
    
    const query = `
      UPDATE time_entries 
      SET 
        status = 'rejected',
        approved_by = $1,
        approved_at = NOW(),
        rejection_reason = $2
      WHERE id = $3
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [approvedBy, rejectionReason || null, id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Time entry not found'
      });
    }
    
    res.json({
      success: true,
      data: transformRow(rows[0], 'time_entries'),
      message: 'Time entry rejected'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/timesheets - Get timesheets with filters
apiRouter.get('/timesheets', async (req, res) => {
  try {
    const { employeeId, status, startDate, endDate } = req.query;
    
    let query = `
      SELECT 
        ts.*,
        e.name as employee_name,
        approver.name as approver_name
      FROM timesheets ts
      LEFT JOIN employees e ON ts.employee_id = e.id
      LEFT JOIN employees approver ON ts.approved_by = approver.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (employeeId) {
      query += ` AND ts.employee_id = $${paramCount}`;
      params.push(employeeId);
      paramCount++;
    }
    
    if (status) {
      query += ` AND ts.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }
    
    if (startDate) {
      query += ` AND ts.period_start >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }
    
    if (endDate) {
      query += ` AND ts.period_end <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }
    
    query += ' ORDER BY ts.period_start DESC';
    
    const { rows } = await db.query(query, params);
    
    const timesheets = rows.map(row => {
      const sheet = transformRow(row, 'timesheets');
      sheet.employeeName = row.employee_name;
      sheet.approverName = row.approver_name;
      return sheet;
    });
    
    res.json({
      success: true,
      data: timesheets
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/timesheets/generate - Generate timesheet for employee and period
apiRouter.post('/timesheets/generate', async (req, res) => {
  try {
    const { employeeId, periodStart, periodEnd } = req.body;
    
    if (!employeeId || !periodStart || !periodEnd) {
      return res.status(400).json({
        success: false,
        error: 'employeeId, periodStart, and periodEnd are required'
      });
    }
    
    // Get all approved time entries in the period
    const entriesQuery = `
      SELECT * FROM time_entries
      WHERE employee_id = $1
        AND clock_in >= $2
        AND clock_in < $3
        AND status = 'approved'
      ORDER BY clock_in
    `;
    
    const { rows: entries } = await db.query(entriesQuery, [employeeId, periodStart, periodEnd]);
    
    // Calculate totals
    let totalHours = 0;
    let regularHours = 0;
    let overtimeHours = 0;
    
    entries.forEach(entry => {
      const hours = entry.hours_worked || 0;
      totalHours += hours;
      
      // Simple overtime calculation: >40 hours per week
      // This is simplified - real payroll would need more complex logic
      if (regularHours < 40) {
        const addRegular = Math.min(hours, 40 - regularHours);
        regularHours += addRegular;
        overtimeHours += Math.max(0, hours - addRegular);
      } else {
        overtimeHours += hours;
      }
    });
    
    const id = uuidv4();
    
    const query = `
      INSERT INTO timesheets (
        id, employee_id, period_start, period_end,
        total_hours, total_regular_hours, total_overtime_hours,
        status, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [
      id,
      employeeId,
      periodStart,
      periodEnd,
      totalHours,
      regularHours,
      overtimeHours,
      'submitted'
    ]);
    
    res.json({
      success: true,
      data: transformRow(rows[0], 'timesheets'),
      message: `Timesheet generated with ${entries.length} entries`,
      entriesCount: entries.length
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/timesheets/:id/approve - Approve a timesheet
apiRouter.put('/timesheets/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approvedBy, notes } = req.body;
    
    if (!approvedBy) {
      return res.status(400).json({
        success: false,
        error: 'approvedBy is required'
      });
    }
    
    const query = `
      UPDATE timesheets 
      SET 
        status = 'approved',
        approved_by = $1,
        approved_at = NOW(),
        notes = COALESCE($2, notes)
      WHERE id = $3
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [approvedBy, notes, id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Timesheet not found'
      });
    }
    
    res.json({
      success: true,
      data: transformRow(rows[0], 'timesheets'),
      message: 'Timesheet approved'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// GLOBAL SEARCH ENDPOINT
// ============================================================================

apiRouter.get('/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (!query || query.length < 2) {
      return res.json({ results: [], total: 0 });
    }

    const searchTerm = `%${query}%`;
    const allResults = [];

    // Search across all entity types
    const [leadsRows, quotesRows, jobsRows, invoicesRows, clientsRows] = await Promise.all([
      db.query(`SELECT id, 'lead' as type, '' as name, source as description, status, created_at FROM leads WHERE (source ILIKE $1) AND deleted_at IS NULL LIMIT 10`, [searchTerm]),
      db.query(`SELECT id, 'quote' as type, quote_number as name, customer_name as description, status, created_at FROM quotes WHERE (quote_number ILIKE $1 OR customer_name ILIKE $1) AND deleted_at IS NULL LIMIT 10`, [searchTerm]),
      db.query(`SELECT id, 'job' as type, job_number as name, customer_name as description, status, created_at FROM jobs WHERE (job_number ILIKE $1 OR customer_name ILIKE $1) AND deleted_at IS NULL LIMIT 10`, [searchTerm]),
      db.query(`SELECT id, 'invoice' as type, invoice_number as name, customer_name as description, status, created_at FROM invoices WHERE (invoice_number ILIKE $1 OR customer_name ILIKE $1) AND deleted_at IS NULL LIMIT 10`, [searchTerm]),
      db.query(`SELECT id, 'client' as type, company_name as name, (first_name || ' ' || last_name) as description, status, created_at FROM clients WHERE (company_name ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1 OR primary_email ILIKE $1) AND deleted_at IS NULL LIMIT 10`, [searchTerm])
    ]);

    allResults.push(...leadsRows.rows.map(r => ({ ...r, category: 'Sales' })));
    allResults.push(...quotesRows.rows.map(r => ({ ...r, category: 'Sales' })));
    allResults.push(...jobsRows.rows.map(r => ({ ...r, category: 'Operations' })));
    allResults.push(...invoicesRows.rows.map(r => ({ ...r, category: 'Finance' })));
    allResults.push(...clientsRows.rows.map(r => ({ ...r, category: 'CRM' })));

    res.json({ results: allResults.slice(0, 50), total: allResults.length });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// EXCEPTION QUEUE ENDPOINTS
// ============================================================================

apiRouter.get('/exception-queue', async (req, res) => {
  try {
    const [pendingQuotes, overdueInvoices, missingForms, followUps] = await Promise.all([
      db.query(`SELECT eq.id, 'quote_pending_approval' as exception_type, q.id as entity_id, q.quote_number, q.customer_name, q.approval_status, q.created_at, 'high' as priority FROM exception_queue eq JOIN quotes q ON q.id = eq.entity_id WHERE eq.exception_type = 'quote_pending_approval' AND eq.is_resolved = false ORDER BY eq.created_at ASC`),
      db.query(`SELECT eq.id, 'invoice_overdue' as exception_type, i.id as entity_id, i.invoice_number, i.customer_name, i.status, i.due_date, CAST(EXTRACT(DAY FROM NOW() - i.due_date) AS INTEGER) as days_overdue, i.balance_amount as amount_due, CASE WHEN EXTRACT(DAY FROM NOW() - i.due_date) > 90 THEN 'critical' WHEN EXTRACT(DAY FROM NOW() - i.due_date) > 60 THEN 'high' ELSE 'medium' END as priority FROM exception_queue eq JOIN invoices i ON i.id = eq.entity_id WHERE eq.exception_type = 'invoice_overdue' AND eq.is_resolved = false ORDER BY i.due_date ASC`),
      db.query(`SELECT eq.id, 'job_missing_forms' as exception_type, j.id as entity_id, j.job_number, j.customer_name, j.status, 'medium' as priority FROM exception_queue eq JOIN jobs j ON j.id = eq.entity_id WHERE eq.exception_type = 'job_missing_forms' AND eq.is_resolved = false ORDER BY j.created_at ASC`),
      db.query(`SELECT eq.id, 'quote_follow_up' as exception_type, q.id as entity_id, q.quote_number, q.customer_name, q.status, 'low' as priority FROM exception_queue eq JOIN quotes q ON q.id = eq.entity_id WHERE eq.exception_type = 'quote_follow_up' AND eq.is_resolved = false ORDER BY eq.created_at ASC`)
    ]);

    const summary = {
      totalExceptions: pendingQuotes.rows.length + overdueInvoices.rows.length + missingForms.rows.length + followUps.rows.length,
      criticalCount: overdueInvoices.rows.filter(i => i.priority === 'critical').length,
      highCount: overdueInvoices.rows.filter(i => i.priority === 'high').length + pendingQuotes.rows.length
    };

    res.json({
      pendingQuotes: pendingQuotes.rows,
      overdueInvoices: overdueInvoices.rows,
      missingForms: missingForms.rows,
      followUps: followUps.rows,
      summary
    });
  } catch (err) {
    handleError(res, err);
  }
});

apiRouter.post('/exception-queue/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`UPDATE exception_queue SET is_resolved = true, resolved_at = NOW() WHERE id = $1`, [id]);
    res.json({ success: true, message: 'Exception resolved' });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// PHC MATERIALS ENDPOINTS (Phase 5)
// ============================================================================

const transformJobMaterial = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    materialName: row.material_name,
    quantityUsed: row.quantity_used ? parseFloat(row.quantity_used) : null,
    unit: row.unit,
    epaRegNumber: row.epa_reg_number,
    applicationMethod: row.application_method,
    applicationRate: row.application_rate,
    targetPestOrCondition: row.target_pest_or_condition,
    appliedBy: row.applied_by,
    appliedAt: row.applied_at,
    weatherConditions: row.weather_conditions,
    windSpeedMph: row.wind_speed_mph ? parseFloat(row.wind_speed_mph) : null,
    temperatureF: row.temperature_f ? parseFloat(row.temperature_f) : null,
    ppeUsed: row.ppe_used,
    reiHours: row.rei_hours,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    employeeName: row.employee_name
  };
};

const transformMaterialInventory = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    materialName: row.material_name,
    manufacturer: row.manufacturer,
    epaRegNumber: row.epa_reg_number,
    activeIngredient: row.active_ingredient,
    formulationType: row.formulation_type,
    defaultUnit: row.default_unit,
    defaultApplicationMethod: row.default_application_method,
    defaultApplicationRate: row.default_application_rate,
    signalWord: row.signal_word,
    requiredPpe: row.required_ppe,
    defaultReiHours: row.default_rei_hours,
    storageRequirements: row.storage_requirements,
    disposalInstructions: row.disposal_instructions,
    currentQuantity: row.current_quantity ? parseFloat(row.current_quantity) : null,
    minimumQuantity: row.minimum_quantity ? parseFloat(row.minimum_quantity) : null,
    unitCost: row.unit_cost ? parseFloat(row.unit_cost) : null,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

// GET /api/jobs/:id/materials - Get all materials for a job
apiRouter.get('/jobs/:id/materials', async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT jm.*, e.name as employee_name
      FROM job_materials jm
      LEFT JOIN employees e ON jm.applied_by = e.id
      WHERE jm.job_id = $1
      ORDER BY jm.created_at DESC
    `;
    
    const { rows } = await db.query(query, [id]);
    
    res.json({
      success: true,
      data: rows.map(transformJobMaterial)
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/jobs/:id/materials - Add material usage to a job
apiRouter.post('/jobs/:id/materials', async (req, res) => {
  try {
    const { id: jobId } = req.params;
    const {
      materialName,
      quantityUsed,
      unit,
      epaRegNumber,
      applicationMethod,
      applicationRate,
      targetPestOrCondition,
      appliedBy,
      appliedAt,
      weatherConditions,
      windSpeedMph,
      temperatureF,
      ppeUsed,
      reiHours,
      notes
    } = req.body;
    
    if (!materialName) {
      return res.status(400).json({
        success: false,
        error: 'materialName is required'
      });
    }
    
    const materialId = uuidv4();
    const userId = req.user?.id || null;
    
    const query = `
      INSERT INTO job_materials (
        id, job_id, material_name, quantity_used, unit,
        epa_reg_number, application_method, application_rate,
        target_pest_or_condition, applied_by, applied_at,
        weather_conditions, wind_speed_mph, temperature_f,
        ppe_used, rei_hours, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [
      materialId,
      jobId,
      materialName,
      quantityUsed || null,
      unit || null,
      epaRegNumber || null,
      applicationMethod || null,
      applicationRate || null,
      targetPestOrCondition || null,
      appliedBy || null,
      appliedAt || null,
      weatherConditions || null,
      windSpeedMph || null,
      temperatureF || null,
      ppeUsed || null,
      reiHours || null,
      notes || null,
      userId
    ]);
    
    res.status(201).json({
      success: true,
      data: transformJobMaterial(rows[0]),
      message: 'Material usage recorded'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/job-materials/:id - Update material record
apiRouter.put('/job-materials/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      materialName,
      quantityUsed,
      unit,
      epaRegNumber,
      applicationMethod,
      applicationRate,
      targetPestOrCondition,
      appliedBy,
      appliedAt,
      weatherConditions,
      windSpeedMph,
      temperatureF,
      ppeUsed,
      reiHours,
      notes
    } = req.body;
    
    const query = `
      UPDATE job_materials SET
        material_name = COALESCE($1, material_name),
        quantity_used = COALESCE($2, quantity_used),
        unit = COALESCE($3, unit),
        epa_reg_number = COALESCE($4, epa_reg_number),
        application_method = COALESCE($5, application_method),
        application_rate = COALESCE($6, application_rate),
        target_pest_or_condition = COALESCE($7, target_pest_or_condition),
        applied_by = COALESCE($8, applied_by),
        applied_at = COALESCE($9, applied_at),
        weather_conditions = COALESCE($10, weather_conditions),
        wind_speed_mph = COALESCE($11, wind_speed_mph),
        temperature_f = COALESCE($12, temperature_f),
        ppe_used = COALESCE($13, ppe_used),
        rei_hours = COALESCE($14, rei_hours),
        notes = COALESCE($15, notes),
        updated_at = NOW()
      WHERE id = $16
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [
      materialName,
      quantityUsed,
      unit,
      epaRegNumber,
      applicationMethod,
      applicationRate,
      targetPestOrCondition,
      appliedBy,
      appliedAt,
      weatherConditions,
      windSpeedMph,
      temperatureF,
      ppeUsed,
      reiHours,
      notes,
      id
    ]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Material record not found'
      });
    }
    
    res.json({
      success: true,
      data: transformJobMaterial(rows[0]),
      message: 'Material record updated'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/job-materials/:id - Remove material record
apiRouter.delete('/job-materials/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows } = await db.query(
      'DELETE FROM job_materials WHERE id = $1 RETURNING id',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Material record not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Material record deleted'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// MATERIAL INVENTORY ENDPOINTS
// ============================================================================

// GET /api/material-inventory - Get all materials for autocomplete
apiRouter.get('/material-inventory', async (req, res) => {
  try {
    const { search, activeOnly } = req.query;
    
    let query = 'SELECT * FROM material_inventory WHERE 1=1';
    const params = [];
    let paramCount = 1;
    
    if (activeOnly !== 'false') {
      query += ' AND is_active = true';
    }
    
    if (search) {
      query += ` AND (material_name ILIKE $${paramCount} OR epa_reg_number ILIKE $${paramCount} OR active_ingredient ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }
    
    query += ' ORDER BY material_name ASC';
    
    const { rows } = await db.query(query, params);
    
    res.json({
      success: true,
      data: rows.map(transformMaterialInventory)
    });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/material-inventory - Add new material to inventory
apiRouter.post('/material-inventory', async (req, res) => {
  try {
    const {
      materialName,
      manufacturer,
      epaRegNumber,
      activeIngredient,
      formulationType,
      defaultUnit,
      defaultApplicationMethod,
      defaultApplicationRate,
      signalWord,
      requiredPpe,
      defaultReiHours,
      storageRequirements,
      disposalInstructions,
      currentQuantity,
      minimumQuantity,
      unitCost
    } = req.body;
    
    if (!materialName) {
      return res.status(400).json({
        success: false,
        error: 'materialName is required'
      });
    }
    
    const id = uuidv4();
    
    const query = `
      INSERT INTO material_inventory (
        id, material_name, manufacturer, epa_reg_number, active_ingredient,
        formulation_type, default_unit, default_application_method,
        default_application_rate, signal_word, required_ppe, default_rei_hours,
        storage_requirements, disposal_instructions, current_quantity,
        minimum_quantity, unit_cost
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `;
    
    const { rows } = await db.query(query, [
      id,
      materialName,
      manufacturer || null,
      epaRegNumber || null,
      activeIngredient || null,
      formulationType || null,
      defaultUnit || null,
      defaultApplicationMethod || null,
      defaultApplicationRate || null,
      signalWord || null,
      requiredPpe || null,
      defaultReiHours || null,
      storageRequirements || null,
      disposalInstructions || null,
      currentQuantity || null,
      minimumQuantity || null,
      unitCost || null
    ]);
    
    res.status(201).json({
      success: true,
      data: transformMaterialInventory(rows[0]),
      message: 'Material added to inventory'
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({
        success: false,
        error: 'Material with this name already exists'
      });
    }
    handleError(res, err);
  }
});

// PUT /api/material-inventory/:id - Update material in inventory
apiRouter.put('/material-inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const setClause = [];
    const params = [];
    let paramCount = 1;
    
    const fieldMap = {
      materialName: 'material_name',
      manufacturer: 'manufacturer',
      epaRegNumber: 'epa_reg_number',
      activeIngredient: 'active_ingredient',
      formulationType: 'formulation_type',
      defaultUnit: 'default_unit',
      defaultApplicationMethod: 'default_application_method',
      defaultApplicationRate: 'default_application_rate',
      signalWord: 'signal_word',
      requiredPpe: 'required_ppe',
      defaultReiHours: 'default_rei_hours',
      storageRequirements: 'storage_requirements',
      disposalInstructions: 'disposal_instructions',
      currentQuantity: 'current_quantity',
      minimumQuantity: 'minimum_quantity',
      unitCost: 'unit_cost',
      isActive: 'is_active'
    };
    
    for (const [key, value] of Object.entries(updates)) {
      if (fieldMap[key]) {
        setClause.push(`${fieldMap[key]} = $${paramCount}`);
        params.push(value);
        paramCount++;
      }
    }
    
    if (setClause.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid fields to update'
      });
    }
    
    setClause.push('updated_at = NOW()');
    params.push(id);
    
    const query = `
      UPDATE material_inventory 
      SET ${setClause.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;
    
    const { rows } = await db.query(query, params);
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Material not found'
      });
    }
    
    res.json({
      success: true,
      data: transformMaterialInventory(rows[0]),
      message: 'Material updated'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/material-inventory/:id - Remove material from inventory (soft delete)
apiRouter.delete('/material-inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { rows } = await db.query(
      'UPDATE material_inventory SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Material not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Material deactivated'
    });
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/phc-reports/compliance - PHC compliance report
apiRouter.get('/phc-reports/compliance', async (req, res) => {
  try {
    const { startDate, endDate, jobId } = req.query;
    
    let query = `
      SELECT 
        jm.*,
        j.job_number,
        j.customer_name,
        j.scheduled_date,
        j.job_location,
        e.name as applicator_name
      FROM job_materials jm
      JOIN jobs j ON jm.job_id = j.id
      LEFT JOIN employees e ON jm.applied_by = e.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (startDate) {
      query += ` AND jm.applied_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }
    
    if (endDate) {
      query += ` AND jm.applied_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }
    
    if (jobId) {
      query += ` AND jm.job_id = $${paramCount}`;
      params.push(jobId);
      paramCount++;
    }
    
    query += ' ORDER BY jm.applied_at DESC, jm.created_at DESC';
    
    const { rows } = await db.query(query, params);
    
    const report = rows.map(row => ({
      id: row.id,
      jobNumber: row.job_number,
      customerName: row.customer_name,
      scheduledDate: row.scheduled_date,
      jobLocation: row.job_location,
      materialName: row.material_name,
      quantityUsed: row.quantity_used ? parseFloat(row.quantity_used) : null,
      unit: row.unit,
      epaRegNumber: row.epa_reg_number,
      applicationMethod: row.application_method,
      applicationRate: row.application_rate,
      targetPestOrCondition: row.target_pest_or_condition,
      applicatorName: row.applicator_name,
      appliedAt: row.applied_at,
      weatherConditions: row.weather_conditions,
      windSpeedMph: row.wind_speed_mph ? parseFloat(row.wind_speed_mph) : null,
      temperatureF: row.temperature_f ? parseFloat(row.temperature_f) : null,
      ppeUsed: row.ppe_used,
      reiHours: row.rei_hours
    }));
    
    res.json({
      success: true,
      data: report,
      summary: {
        totalApplications: rows.length,
        uniqueMaterials: [...new Set(rows.map(r => r.material_name))].length,
        dateRange: {
          start: startDate || 'all time',
          end: endDate || 'present'
        }
      }
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================================
// GENERIC CRUD ENDPOINTS
// ============================================================================

const resources = ['clients', 'leads', 'jobs', 'employees', 'equipment', 'pay_periods', 'time_entries', 'payroll_records', 'estimate_feedback'];
resources.forEach(resource => {
  setupCrudEndpoints(apiRouter, resource);
});

let appInitialized = false;
let appInitPromise = null;
let staticMounted = false;

async function initializeApp({ includeStatic = true } = {}) {
  if (!appInitPromise) {
    appInitPromise = (async () => {
      await initStripe();
      await setupAuth(app);
  
      mountApiRoutes(app, apiRouter);
      app.use('/api', notFoundHandler);
      app.use(errorHandler);
      appInitialized = true;
    })().catch(err => {
      appInitPromise = null;
      throw err;
    });
  }

  await appInitPromise;

  if (includeStatic && !staticMounted) {
    // In serverless/Vercel we serve static assets separately, so allow skipping
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
    staticMounted = true;
  }
}

async function startServer() {
  await initializeApp({ includeStatic: true });

  server = app.listen(PORT, HOST, async () => {
    console.log(`Backend server running on http://${HOST}:${PORT}`);

    try {
      await ragService.initialize();
      console.log('🤖 RAG Service ready');
    } catch (error) {
      console.error('⚠️ RAG Service initialization failed:', error);
      console.log('💡 Run POST /api/rag/build to build the vector database');
    }

    scheduleFinancialReminders();

    try {
      initializeAutomationEngine();
      console.log('⚙️ Automation Engine initialized');
    } catch (error) {
      console.error('⚠️ Automation Engine initialization failed:', error);
      console.log('💡 Workflows may not run automatically until this is resolved');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use.`);
      console.error('   This error has been caught and will not crash the server.');
      console.error('   The server will remain stopped. Please check for other running instances.');
    } else {
      console.error('❌ Server error:', err);
      shutdown(1);
    }
  });
}

async function shutdown(exitCode = 0) {
  console.log('\n🔄 Initiating graceful shutdown...');
  
  try {
    shutdownAutomationEngine();
    console.log('✅ Automation Engine shut down');
  } catch (error) {
    console.error('⚠️ Error shutting down Automation Engine:', error.message);
  }
  
  if (reminderInterval) {
    clearInterval(reminderInterval);
    console.log('✅ Cleared reminder interval');
  }

  if (server) {
    await new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          console.error('❌ Error closing HTTP server:', err.message);
        } else {
          console.log('✅ HTTP server closed');
        }
        resolve();
      });
    });
  }

  await db.closePool();

  console.log('✅ Graceful shutdown complete');
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

process.on('SIGTERM', () => {
  console.log('📥 SIGTERM received');
  shutdown(0);
});

process.on('SIGINT', () => {
  console.log('📥 SIGINT received');
  shutdown(0);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  shutdown(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown(1);
});

// Export for testing
module.exports = {
  app,
  initializeApp,
  startServer,
  stopServer: shutdown,
  getServer: () => server
};

// Only start server automatically if this file is run directly (not imported for testing)
if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
