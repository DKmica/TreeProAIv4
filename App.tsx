import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import ProtectedRoute from './components/ProtectedRoute';
import RoleProtectedRoute from './components/RoleProtectedRoute';
import CrewLayout from './components/CrewLayout';
import CustomerPortalLayout from './components/CustomerPortalLayout';
import SpinnerIcon from './components/icons/SpinnerIcon';
import { AppDataProvider } from './contexts/AppDataContext';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const CRM = lazy(() => import('./pages/CRM'));
const ClientDetail = lazy(() => import('./pages/ClientDetail'));
const QuoteDetail = lazy(() => import('./pages/QuoteDetail'));
const Jobs = lazy(() => import('./pages/Jobs'));
const JobTemplates = lazy(() => import('./pages/JobTemplates'));
const FormTemplates = lazy(() => import('./pages/FormTemplates'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceTemplates = lazy(() => import('./pages/InvoiceTemplates'));
const ARAgingDashboard = lazy(() => import('./pages/ARAgingDashboard'));
const Calendar = lazy(() => import('./pages/Calendar'));
const Crews = lazy(() => import('./pages/Crews'));
const TimeTracking = lazy(() => import('./pages/TimeTracking'));
const Employees = lazy(() => import('./pages/Employees'));
const Equipment = lazy(() => import('./pages/Equipment'));
const EquipmentDetail = lazy(() => import('./pages/EquipmentDetail'));
const Marketing = lazy(() => import('./pages/Marketing'));
const AICore = lazy(() => import('./pages/AICore'));
const AITreeEstimator = lazy(() => import('./pages/AITreeEstimator'));
const EstimateFeedbackAnalytics = lazy(() => import('./pages/EstimateFeedbackAnalytics'));
const ChatPage = lazy(() => import('./pages/Chat'));
const Profitability = lazy(() => import('./pages/Profitability'));
const Reports = lazy(() => import('./pages/Reports'));
const ExceptionQueue = lazy(() => import('./pages/ExceptionQueue'));
const Settings = lazy(() => import('./pages/Settings'));
const TemplateViewer = lazy(() => import('./pages/TemplateViewer'));
const Payroll = lazy(() => import('./pages/Payroll'));
const Workflows = lazy(() => import('./pages/Workflows'));
const PHCComplianceReport = lazy(() => import('./pages/PHCComplianceReport'));
const AutomationLogs = lazy(() => import('./pages/AutomationLogs'));
const DocumentScanner = lazy(() => import('./pages/DocumentScanner'));
const Visualizer = lazy(() => import('./pages/Visualizer'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const CrewDashboard = lazy(() => import('./pages/crew/CrewDashboard'));
const CrewJobDetail = lazy(() => import('./pages/crew/CrewJobDetail'));
const QuotePortal = lazy(() => import('./pages/portal/QuotePortal'));
const InvoicePortal = lazy(() => import('./pages/portal/InvoicePortal'));
const JobStatusPortal = lazy(() => import('./pages/portal/JobStatusPortal'));
const ClientHub = lazy(() => import('./pages/portal/ClientHub'));
const AdminSetup = lazy(() => import('./pages/AdminSetup'));

const PageLoader: React.FC = () => (
  <div className="flex items-center justify-center min-h-[400px]">
    <div className="text-center">
      <SpinnerIcon className="w-10 h-10 animate-spin text-brand-cyan-400 mx-auto mb-3" />
      <p className="text-brand-gray-400 text-sm">Loading...</p>
    </div>
  </div>
);

const App: React.FC = () => {
  return (
    <AppDataProvider>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/admin-setup" element={
            <Suspense fallback={<PageLoader />}>
              <AdminSetup />
            </Suspense>
          } />

          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={
                <Suspense fallback={<PageLoader />}>
                  <Dashboard />
                </Suspense>
              } />
              <Route path="/crm" element={<Suspense fallback={<PageLoader />}><CRM /></Suspense>} />
              <Route path="/crm/clients/:id" element={<Suspense fallback={<PageLoader />}><ClientDetail /></Suspense>} />
              <Route path="/quotes/:id" element={<Suspense fallback={<PageLoader />}><QuoteDetail /></Suspense>} />
              <Route path="/ai-core" element={<Suspense fallback={<PageLoader />}><AICore /></Suspense>} />
              <Route path="/ai-tree-estimator" element={<Suspense fallback={<PageLoader />}><AITreeEstimator /></Suspense>} />
              <Route path="/estimate-feedback-analytics" element={<Suspense fallback={<PageLoader />}><EstimateFeedbackAnalytics /></Suspense>} />
              <Route path="/chat" element={<Suspense fallback={<PageLoader />}><ChatPage /></Suspense>} />
              <Route path="/leads" element={<Navigate to="/crm?tab=leads" replace />} />
              <Route path="/quotes" element={<Navigate to="/crm?tab=quotes" replace />} />
              <Route path="/jobs" element={<Suspense fallback={<PageLoader />}><Jobs /></Suspense>} />
              <Route path="/job-templates" element={<Suspense fallback={<PageLoader />}><JobTemplates /></Suspense>} />
              <Route path="/forms" element={<Suspense fallback={<PageLoader />}><FormTemplates /></Suspense>} />
              <Route path="/customers" element={<Navigate to="/crm?tab=clients" replace />} />
              <Route path="/invoices" element={<Suspense fallback={<PageLoader />}><Invoices /></Suspense>} />
              <Route path="/invoice-templates" element={
                <RoleProtectedRoute allowedRoles={['owner', 'admin', 'manager']}>
                  <Suspense fallback={<PageLoader />}><InvoiceTemplates /></Suspense>
                </RoleProtectedRoute>
              } />
              <Route path="/ar-aging" element={
                <RoleProtectedRoute allowedRoles={['owner', 'admin', 'manager']}>
                  <Suspense fallback={<PageLoader />}><ARAgingDashboard /></Suspense>
                </RoleProtectedRoute>
              } />
              <Route path="/calendar" element={<Suspense fallback={<PageLoader />}><Calendar /></Suspense>} />
              <Route path="/crews" element={<Suspense fallback={<PageLoader />}><Crews /></Suspense>} />
              <Route path="/time-tracking" element={<Suspense fallback={<PageLoader />}><TimeTracking /></Suspense>} />
              <Route path="/employees" element={
                <RoleProtectedRoute allowedRoles={['owner', 'admin', 'manager']}>
                  <Suspense fallback={<PageLoader />}><Employees /></Suspense>
                </RoleProtectedRoute>
              } />
              <Route path="/payroll" element={
                <RoleProtectedRoute allowedRoles={['owner', 'admin']}>
                  <Suspense fallback={<PageLoader />}><Payroll /></Suspense>
                </RoleProtectedRoute>
              } />
              <Route path="/equipment" element={<Suspense fallback={<PageLoader />}><Equipment /></Suspense>} />
              <Route path="/equipment/:equipmentId" element={<Suspense fallback={<PageLoader />}><EquipmentDetail /></Suspense>} />
              <Route path="/phc-compliance" element={<Suspense fallback={<PageLoader />}><PHCComplianceReport /></Suspense>} />
              <Route path="/marketing" element={<Suspense fallback={<PageLoader />}><Marketing /></Suspense>} />
              <Route path="/profitability" element={
                <RoleProtectedRoute allowedRoles={['owner', 'admin']}>
                  <Suspense fallback={<PageLoader />}><Profitability /></Suspense>
                </RoleProtectedRoute>
              } />
              <Route path="/reports" element={
                <RoleProtectedRoute allowedRoles={['owner', 'admin', 'manager']}>
                  <Suspense fallback={<PageLoader />}><Reports /></Suspense>
                </RoleProtectedRoute>
              } />
              <Route path="/exception-queue" element={<Suspense fallback={<PageLoader />}><ExceptionQueue /></Suspense>} />
              <Route path="/settings" element={
                <RoleProtectedRoute allowedRoles={['owner', 'admin', 'manager']}>
                  <Suspense fallback={<PageLoader />}><Settings /></Suspense>
                </RoleProtectedRoute>
              } />
              <Route path="/settings/template/:templateId" element={<Suspense fallback={<PageLoader />}><TemplateViewer /></Suspense>} />
              <Route path="/workflows" element={<Suspense fallback={<PageLoader />}><Workflows /></Suspense>} />
              <Route path="/automation-logs" element={<Suspense fallback={<PageLoader />}><AutomationLogs /></Suspense>} />
              <Route path="/document-scanner" element={<Suspense fallback={<PageLoader />}><DocumentScanner /></Suspense>} />
              <Route path="/visualizer" element={<Suspense fallback={<PageLoader />}><Visualizer /></Suspense>} />
              <Route path="/user-management" element={
                <RoleProtectedRoute allowedRoles={['owner']}>
                  <Suspense fallback={<PageLoader />}><UserManagement /></Suspense>
                </RoleProtectedRoute>
              } />
            </Route>
          </Route>

          <Route path="/crew" element={<CrewLayout />}>
            <Route index element={<Suspense fallback={<PageLoader />}><CrewDashboard /></Suspense>} />
            <Route path="job/:jobId" element={<Suspense fallback={<PageLoader />}><CrewJobDetail /></Suspense>} />
          </Route>

          <Route path="/portal" element={<CustomerPortalLayout />}>
            <Route path="client/:clientId" element={<Suspense fallback={<PageLoader />}><ClientHub /></Suspense>} />
            <Route path="quote/:quoteId" element={<Suspense fallback={<PageLoader />}><QuotePortal /></Suspense>} />
            <Route path="invoice/:invoiceId" element={<Suspense fallback={<PageLoader />}><InvoicePortal /></Suspense>} />
            <Route path="job/:jobId" element={<Suspense fallback={<PageLoader />}><JobStatusPortal /></Suspense>} />
          </Route>
        </Routes>
      </Suspense>
    </AppDataProvider>
  );
};

export default App;