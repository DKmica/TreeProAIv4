import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../services/apiService';
import { aiCore } from '../services/gemini/aiCore';

interface AppDataContextType {
  isAiCoreInitialized: boolean;
  initializeAiCore: () => Promise<void>;
  invalidateAll: () => void;
}

const AppDataContext = createContext<AppDataContextType | null>(null);

export function useAppData(): AppDataContextType {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error('useAppData must be used within AppDataProvider');
  }
  return context;
}

export function useAiCoreStatus() {
  return useAppData().isAiCoreInitialized;
}

export function useInitializeAiCore() {
  return useAppData().initializeAiCore;
}

export function useInvalidateAll() {
  return useAppData().invalidateAll;
}

interface AppDataProviderProps {
  children: ReactNode;
}

export const AppDataProvider: React.FC<AppDataProviderProps> = ({ children }) => {
  const queryClient = useQueryClient();
  const [isAiCoreInitialized, setIsAiCoreInitialized] = useState(false);
  const aiCoreInitStarted = useRef(false);

  const initializeAiCore = useCallback(async () => {
    if (aiCoreInitStarted.current || isAiCoreInitialized) return;
    
    aiCoreInitStarted.current = true;
    
    try {
      const [clients, leads, quotes, jobs, invoices, employees, equipment, payrollRecords, timeEntries, payPeriods, companyProfile] = await Promise.all([
        api.clientService.getAll().catch(() => []),
        api.leadService.getAll().catch(() => []),
        api.quoteService.getAll().catch(() => []),
        api.jobService.getAll().catch(() => []),
        api.invoiceService.getAll().catch(() => []),
        api.employeeService.getAll().catch(() => []),
        api.equipmentService.getAll().catch(() => []),
        api.payrollRecordService.getAll().catch(() => []),
        api.timeEntryService.getAll().catch(() => []),
        api.payPeriodService.getAll().catch(() => []),
        api.companyProfileService.get().catch(() => null)
      ]);

      if (clients.length === 0 && leads.length === 0 && jobs.length === 0) {
        setIsAiCoreInitialized(true);
        return;
      }

      await aiCore.initialize({
        clients,
        leads,
        quotes,
        jobs,
        invoices,
        employees,
        equipment,
        payrollRecords,
        timeEntries,
        payPeriods,
        companyProfile,
        lastUpdated: new Date()
      });
      
      console.log('✅ AI Core initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize AI Core:', error);
    } finally {
      setIsAiCoreInitialized(true);
    }
  }, [isAiCoreInitialized]);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['clients'] });
    queryClient.invalidateQueries({ queryKey: ['leads'] });
    queryClient.invalidateQueries({ queryKey: ['quotes'] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
    queryClient.invalidateQueries({ queryKey: ['employees'] });
    queryClient.invalidateQueries({ queryKey: ['equipment'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
  }, [queryClient]);

  const value: AppDataContextType = {
    isAiCoreInitialized,
    initializeAiCore,
    invalidateAll,
  };

  return (
    <AppDataContext.Provider value={value}>
      {children}
    </AppDataContext.Provider>
  );
};