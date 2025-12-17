import React, { useEffect, useMemo, useState } from 'react';
import { Job, Crew, RouteOptimizationResult, CrewAvailabilitySummary, WeatherImpact, DispatchResult, RouteStop, AiJobDurationPrediction, AiSchedulingSuggestion } from '../types';
import { CalendarView } from './Calendar/types';
import JobIcon from '../components/icons/JobIcon';
import GoogleCalendarIcon from '../components/icons/GoogleCalendarIcon';
import SpinnerIcon from '../components/icons/SpinnerIcon';
import TemplateSelector from '../components/TemplateSelector';
import { syncJobsToGoogleCalendar } from '../services/googleCalendarService';
import * as api from '../services/apiService';
import { useJobsQuery, useEmployeesQuery, useClientsQuery } from '../hooks/useDataQueries';
import RoutePlanDrawer from '../components/RoutePlanDrawer';
import { useToast } from '../components/ui/Toast';
import AiInsightsPanel from '../components/AiInsightsPanel';

import MonthView from './Calendar/views/MonthView';
import WeekView from './Calendar/views/WeekView';
import DayView from './Calendar/views/DayView';
import ThreeDayView from './Calendar/views/ThreeDayView';
import ListView from './Calendar/views/ListView';
import MapViewWrapper from './Calendar/views/MapViewWrapper';
import CrewView from './Calendar/views/CrewView';

const Calendar: React.FC = () => {
    const { data: jobs = [], isLoading: jobsLoading, refetch: refetchJobs } = useJobsQuery();
    const { data: employees = [], isLoading: employeesLoading } = useEmployeesQuery();
    const { data: customers = [], isLoading: customersLoading } = useClientsQuery();
    const [currentDate, setCurrentDate] = useState(new Date());
    const [activeView, setActiveView] = useState<CalendarView>('month');
    const [statusFilter, setStatusFilter] = useState('all');
    const [employeeFilter, setEmployeeFilter] = useState('all');
    const [draggedJobId, setDraggedJobId] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [showTemplateSelector, setShowTemplateSelector] = useState(false);
    const [crews, setCrews] = useState<Crew[]>([]);
    const [selectedCrewId, setSelectedCrewId] = useState<string>('');
    const [routePlan, setRoutePlan] = useState<RouteOptimizationResult | null>(null);
    const [routeLoading, setRouteLoading] = useState(false);
    const [availabilitySummaries, setAvailabilitySummaries] = useState<CrewAvailabilitySummary[]>([]);
    const [weatherInsights, setWeatherInsights] = useState<WeatherImpact[]>([]);
    const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);
    const [opsLoading, setOpsLoading] = useState(false);
    const [opsError, setOpsError] = useState<string | null>(null);
    const [dispatchLoading, setDispatchLoading] = useState(false);
    const [isRouteDrawerOpen, setIsRouteDrawerOpen] = useState(false);
    const [aiSuggestions, setAiSuggestions] = useState<AiSchedulingSuggestion[]>([]);
    const [aiPredictions, setAiPredictions] = useState<AiJobDurationPrediction[]>([]);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const toast = useToast();

    useEffect(() => {
        let isMounted = true;

        const loadCrews = async () => {
            try {
                const crewData = await api.crewService.getAll();
                if (!isMounted) return;
                setCrews(crewData);
                if (crewData.length > 0) {
                    setSelectedCrewId(prev => prev || crewData[0].id);
                }
            } catch (error) {
                console.error('Failed to load crews:', error);
            }
        };

        loadCrews();
        return () => {
            isMounted = false;
        };
    }, []);

    const schedulableJobs = useMemo(() => {
        return jobs.filter(job => job.status === 'draft' || job.status === 'scheduled' || job.status === 'en_route' || job.status === 'on_site' || job.status === 'in_progress')
            .sort((a, b) => a.id.localeCompare(b.id));
    }, [jobs]);

    useEffect(() => {
        const startOfWeek = new Date(currentDate);
        startOfWeek.setDate(currentDate.getDate() - currentDate.getDay());
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        const startDate = startOfWeek.toISOString().split('T')[0];
        const endDate = endOfWeek.toISOString().split('T')[0];

        const loadOperationalIntel = async () => {
            setOpsLoading(true);
            setOpsError(null);
            try {
                const [availabilityData, weatherData] = await Promise.all([
                    api.operationsService.getAvailability({
                        startDate,
                        endDate,
                        crewId: selectedCrewId || undefined
                    }),
                    api.operationsService.getWeatherImpacts({
                        startDate,
                        endDate,
                        crewId: selectedCrewId || undefined
                    })
                ]);
                setAvailabilitySummaries(availabilityData);
                setWeatherInsights(weatherData);
            } catch (error: any) {
                console.error('Failed to load operations intelligence:', error);
                setOpsError(error?.message || 'Unable to load scheduling intelligence');
            } finally {
                setOpsLoading(false);
            }
        };

        loadOperationalIntel();
    }, [currentDate, selectedCrewId]);

    const filteredJobsOnCalendar = useMemo(() => {
        return jobs.filter(job => {
            const statusMatch = statusFilter === 'all' || job.status === statusFilter;
            const employeeMatch = employeeFilter === 'all' || job.assignedCrew.includes(employeeFilter);
            return statusMatch && employeeMatch;
        });
    }, [jobs, statusFilter, employeeFilter]);

    const currentDateString = useMemo(() => currentDate.toISOString().split('T')[0], [currentDate]);

    useEffect(() => {
        const loadRoutePlan = async () => {
            if (!selectedCrewId) {
                setRoutePlan(null);
                return;
            }

            try {
                const existingPlan = await api.operationsService.getRoutePlan({
                    date: currentDateString,
                    crewId: selectedCrewId
                });
                setRoutePlan(existingPlan);
            } catch (error) {
                console.error('Failed to load route plan', error);
            } finally {
                setIsRouteDrawerOpen(false);
            }
        };

        loadRoutePlan();
    }, [currentDateString, selectedCrewId]);

    useEffect(() => {
        const loadAiSchedulingInsights = async () => {
            setAiLoading(true);
            setAiError(null);
            try {
                const response = await api.aiService.getScheduleSuggestions({
                    date: currentDateString,
                    crewId: selectedCrewId || undefined
                });
                setAiSuggestions(response?.suggestions || []);
                setAiPredictions(response?.predictions || []);
            } catch (error: any) {
                console.error('Failed to load AI scheduling suggestions', error);
                setAiError(error?.message || 'AI scheduling assistant is unavailable right now');
            } finally {
                setAiLoading(false);
            }
        };

        loadAiSchedulingInsights();
    }, [currentDateString, selectedCrewId]);

    const handleOptimizeRoute = async () => {
        setRouteLoading(true);
        setRoutePlan(null);
        setOpsError(null);
        try {
            const plan = await api.operationsService.optimizeRoute({
                date: currentDateString,
                crewId: selectedCrewId || undefined,
                includeInProgress: true
            });
            setRoutePlan(plan);
            setIsRouteDrawerOpen(true);
        } catch (error: any) {
            console.error('Failed to optimize crew route:', error);
            setOpsError(error?.message || 'Unable to optimize route for the selected day');
        } finally {
            setRouteLoading(false);
        }
    };

    const handleDispatchCrew = async () => {
        setDispatchLoading(true);
        setOpsError(null);
        try {
            const result = await api.operationsService.dispatchCrewNotifications({
                date: currentDateString,
                crewId: selectedCrewId || undefined
            });
            setDispatchResult(result);
        } catch (error: any) {
            console.error('Failed to prepare dispatch digest:', error);
            setOpsError(error?.message || 'Unable to prepare crew dispatch digest');
        } finally {
            setDispatchLoading(false);
        }
    };

    const reorderStops = (stops: RouteStop[], jobId: string, direction: 'up' | 'down') => {
        const index = stops.findIndex(stop => stop.jobId === jobId);
        if (index === -1) return stops;

        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= stops.length) return stops;

        const newStops = [...stops];
        const [moved] = newStops.splice(index, 1);
        newStops.splice(targetIndex, 0, moved);

        return newStops.map((stop, idx) => ({ ...stop, order: idx + 1 }));
    };

    const handleReorderStop = async (jobId: string, direction: 'up' | 'down') => {
        if (!routePlan) return;

        const updatedStops = reorderStops(routePlan.stops, jobId, direction);
        if (updatedStops === routePlan.stops) return;

        const previousPlan = routePlan;
        setRoutePlan({ ...routePlan, stops: updatedStops });

        try {
            if (routePlan.routePlanId) {
                await api.operationsService.reorderRoutePlan(routePlan.routePlanId, updatedStops.map(stop => ({
                    jobId: stop.jobId,
                    order: stop.order
                })));
                toast.success('Route updated', 'Stop order saved for dispatch.');
            } else {
                toast.info('Route reordered locally', 'Re-run optimization to persist the new sequence.');
            }
        } catch (error: any) {
            console.error('Failed to reorder route plan', error);
            toast.error('Unable to reorder route', error?.message || 'Please try again.');
            setRoutePlan(previousPlan);
        }
    };

    const handleReorderStopsList = async (orderedStops: { jobId: string; order: number }[]) => {
        if (!routePlan) return;

        const stopLookup = new Map(routePlan.stops.map(stop => [stop.jobId, stop]));
        const nextStops = orderedStops
            .map(item => {
                const existing = stopLookup.get(item.jobId);
                if (!existing) return null;
                return { ...existing, order: item.order };
            })
            .filter(Boolean) as RouteStop[];

        const previousPlan = routePlan;
        setRoutePlan({ ...routePlan, stops: nextStops });

        try {
            if (routePlan.routePlanId) {
                await api.operationsService.reorderRoutePlan(routePlan.routePlanId, orderedStops);
                toast.success('Route updated', 'Stop order saved for dispatch.');
            } else {
                toast.info('Route reordered locally', 'Re-run optimization to persist the new sequence.');
            }
        } catch (error: any) {
            console.error('Failed to reorder route plan', error);
            toast.error('Unable to reorder route', error?.message || 'Please try again.');
            setRoutePlan(previousPlan);
        }
    };

    const handleOnMyWay = async (jobId: string, etaMinutes?: number) => {
        try {
            const response = await api.operationsService.sendOnMyWay({
                jobId,
                crewId: selectedCrewId || undefined,
                etaMinutes: etaMinutes || 15,
                channel: 'sms'
            });
            toast.success('On my way sent', response.message);
        } catch (error: any) {
            console.error('Failed to notify customer', error);
            toast.error('Could not send notification', error?.message || 'Check contact info and try again.');
        }
    };

    const handleOpenDispatcherChat = (prefill: string) => {
        const url = `/chat?prefill=${encodeURIComponent(prefill)}`;
        window.location.href = url;
    };

    const weatherToDisplay = useMemo(() => {
        const flagged = weatherInsights.filter(item => item.riskLevel !== 'low');
        if (flagged.length > 0) {
            return flagged.slice(0, 3);
        }
        return weatherInsights.slice(0, 3);
    }, [weatherInsights]);

    const availabilityToDisplay = useMemo(() => {
        return availabilitySummaries
            .slice()
            .sort((a, b) => a.availableHours - b.availableHours)
            .slice(0, 3);
    }, [availabilitySummaries]);

    const aiInsightItems = useMemo(() => {
        return aiSuggestions.map(suggestion => ({
            id: suggestion.id,
            title: suggestion.title,
            description: suggestion.description,
            confidence: suggestion.confidence,
            tag: suggestion.impact.replace('_', ' '),
            meta: suggestion.etaDeltaMinutes
                ? `${suggestion.etaDeltaMinutes > 0 ? 'Adds' : 'Saves'} ${Math.abs(suggestion.etaDeltaMinutes)} minutes vs baseline`
                : suggestion.rationale,
        }));
    }, [aiSuggestions]);

    const jobLookup = useMemo(() => new Map(jobs.map(job => [job.id, job])), [jobs]);

    const jobsByDate = useMemo(() => {
        const map = new Map<string, Job[]>();
        filteredJobsOnCalendar.forEach(job => {
            const date = job.scheduledDate;
            if (!date) return;
            if (!map.has(date)) {
                map.set(date, []);
            }
            map.get(date)?.push(job);
        });
        return map;
    }, [filteredJobsOnCalendar]);

    const goToPreviousMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    const goToNextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    
    const goToPreviousWeek = () => {
        const newDate = new Date(currentDate);
        newDate.setDate(currentDate.getDate() - 7);
        setCurrentDate(newDate);
    };
    
    const goToNextWeek = () => {
        const newDate = new Date(currentDate);
        newDate.setDate(currentDate.getDate() + 7);
        setCurrentDate(newDate);
    };
    
    const goToPreviousDay = () => {
        const newDate = new Date(currentDate);
        newDate.setDate(currentDate.getDate() - 1);
        setCurrentDate(newDate);
    };
    
    const goToNextDay = () => {
        const newDate = new Date(currentDate);
        newDate.setDate(currentDate.getDate() + 1);
        setCurrentDate(newDate);
    };

    const goToToday = () => setCurrentDate(new Date());

    const handleSyncCalendar = async () => {
        setIsSyncing(true);
        const jobsToSync = jobs.filter(j => j.status === 'scheduled' && j.scheduledDate);
        try {
            const result = await syncJobsToGoogleCalendar(jobsToSync);
            alert(`Successfully synced ${result.eventsCreated} jobs to Google Calendar.`);
        } catch (error: any) {
            alert(`Failed to sync calendar: ${error.message}`);
        } finally {
            setIsSyncing(false);
        }
    };

    const handleUseTemplate = async (templateId: string) => {
        try {
            await api.jobTemplateService.useTemplate(templateId);
            refetchJobs();
            setShowTemplateSelector(false);
        } catch (error: any) {
            console.error('Failed to create job from template:', error);
            alert(`Failed to create job from template: ${error.message || 'Unknown error'}`);
        }
    };

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, jobId: string) => {
        e.dataTransfer.setData('jobId', jobId);
        setDraggedJobId(jobId);
    };

    const handleDragEnd = () => setDraggedJobId(null);
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => e.preventDefault();
    
    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const target = e.target as HTMLDivElement;
        const dayCell = target.closest('.calendar-day');
        if (dayCell) dayCell.classList.add('bg-brand-green-100');
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const target = e.target as HTMLDivElement;
        const dayCell = target.closest('.calendar-day');
        if (dayCell) dayCell.classList.remove('bg-brand-green-100');
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>, date: Date | null) => {
        e.preventDefault();
        const target = e.target as HTMLDivElement;
        const dayCell = target.closest('.calendar-day');
        if (dayCell) dayCell.classList.remove('bg-brand-green-100');
        
        if (!date) return;

        const jobId = e.dataTransfer.getData('jobId');
        const newScheduledDate = date.toISOString().split('T')[0];

        try {
            await api.jobService.update(jobId, { scheduledDate: newScheduledDate, status: 'scheduled' });
            refetchJobs();
        } catch (error) {
            console.error('Failed to update job:', error);
        }
    };
    
    const getStatusColor = (status: Job['status']) => {
        switch (status) {
            case 'scheduled': return 'bg-blue-100 text-blue-800 border-blue-200';
            case 'in_progress': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
            case 'draft': return 'bg-gray-100 text-gray-800 border-gray-200';
            default: return 'bg-gray-100 text-gray-800 border-gray-200';
        }
    };

    const getNavigationControls = () => {
        switch (activeView) {
            case 'month':
                return (
                    <>
                        <button onClick={goToPreviousMonth} className="text-brand-gray-500 hover:text-brand-gray-700 p-1 rounded-full hover:bg-gray-100">
                            <span className="sr-only">Previous month</span>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                        </button>
                        <h2 className="text-base md:text-lg font-semibold text-brand-gray-800 text-center w-48">
                            {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
                        </h2>
                        <button onClick={goToNextMonth} className="text-brand-gray-500 hover:text-brand-gray-700 p-1 rounded-full hover:bg-gray-100">
                            <span className="sr-only">Next month</span>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
                        </button>
                    </>
                );
            case 'week':
            case 'crew':
                return (
                    <>
                        <button onClick={goToPreviousWeek} className="text-brand-gray-500 hover:text-brand-gray-700 p-1 rounded-full hover:bg-gray-100">
                            <span className="sr-only">Previous week</span>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                        </button>
                        <h2 className="text-base md:text-lg font-semibold text-brand-gray-800 text-center w-48">
                            Week of {currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </h2>
                        <button onClick={goToNextWeek} className="text-brand-gray-500 hover:text-brand-gray-700 p-1 rounded-full hover:bg-gray-100">
                            <span className="sr-only">Next week</span>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
                        </button>
                    </>
                );
            case 'day':
            case '3-day':
                return (
                    <>
                        <button onClick={goToPreviousDay} className="text-brand-gray-500 hover:text-brand-gray-700 p-1 rounded-full hover:bg-gray-100">
                            <span className="sr-only">Previous day</span>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                        </button>
                        <h2 className="text-base md:text-lg font-semibold text-brand-gray-800 text-center w-48">
                            {currentDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                        </h2>
                        <button onClick={goToNextDay} className="text-brand-gray-500 hover:text-brand-gray-700 p-1 rounded-full hover:bg-gray-100">
                            <span className="sr-only">Next day</span>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
                        </button>
                    </>
                );
            default:
                return <div className="w-48"></div>;
        }
    };

    const handleJobDrop = async (jobId: string, newDate: string) => {
        try {
            await api.jobService.update(jobId, { scheduledDate: newDate, status: 'scheduled' });
            refetchJobs();
        } catch (error) {
            console.error('Failed to update job:', error);
        }
    };

    const dataLoading = jobsLoading || employeesLoading || customersLoading;

    const viewProps = {
        jobs,
        employees,
        currentDate,
        statusFilter,
        employeeFilter,
        filteredJobs: filteredJobsOnCalendar,
        jobsByDate,
        onDateChange: setCurrentDate,
        onJobDrop: handleJobDrop,
        refetchJobs,
        handleDragStart,
        handleDragEnd,
        handleDragOver,
        handleDragEnter,
        handleDragLeave,
        handleDrop,
        draggedJobId
    };

    return (
        <div>
            <h1 className="text-2xl font-bold text-brand-gray-900">Jobs Calendar</h1>
            
            <div className="mt-6 flex flex-col lg:flex-row lg:space-x-8">
                {activeView !== 'list' && activeView !== 'map' && activeView !== 'crew' && (
                    <div className="lg:w-1/3 xl:w-1/4">
                        <h2 className="text-xl font-bold text-brand-gray-900">Jobs List</h2>
                        <div className="mt-4 bg-white p-3 rounded-lg shadow-sm border border-brand-gray-200 space-y-3 max-h-[80vh] overflow-y-auto">
                            {schedulableJobs.length > 0 ? schedulableJobs.map(job => (
                                <div 
                                    key={job.id}
                                    draggable="true"
                                    onDragStart={(e) => handleDragStart(e, job.id)}
                                    onDragEnd={handleDragEnd}
                                    className={`p-3 rounded-lg border cursor-move hover:shadow-lg transition-all ${draggedJobId === job.id ? 'opacity-50 scale-105 shadow-xl bg-brand-green-50' : 'bg-white shadow-sm'}`}
                                >
                                    <div className="flex justify-between items-start">
                                        <p className="font-semibold text-brand-gray-800 flex items-center"><JobIcon className="w-4 h-4 mr-2 text-brand-gray-400"/> {job.id}</p>
                                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getStatusColor(job.status)}`}>
                                            {job.status}
                                        </span>
                                    </div>
                                    <p className="text-sm text-brand-gray-600 mt-1">{job.customerName}</p>
                                </div>
                            )) : (
                                <div className="text-center py-10">
                                    <p className="text-sm text-brand-gray-500">No active jobs to schedule.</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {activeView === 'crew' && (
                    <div className="lg:w-1/4 xl:w-1/5">
                        <h2 className="text-xl font-bold text-brand-gray-900">Jobs List</h2>
                        <div className="mt-4 bg-white p-3 rounded-lg shadow-sm border border-brand-gray-200 space-y-3 max-h-[80vh] overflow-y-auto">
                            {schedulableJobs.length > 0 ? schedulableJobs.map(job => (
                                <div 
                                    key={job.id}
                                    draggable="true"
                                    onDragStart={(e) => handleDragStart(e, job.id)}
                                    onDragEnd={handleDragEnd}
                                    className={`p-3 rounded-lg border cursor-move hover:shadow-lg transition-all ${draggedJobId === job.id ? 'opacity-50 scale-105 shadow-xl bg-brand-green-50' : 'bg-white shadow-sm'}`}
                                >
                                    <div className="flex justify-between items-start">
                                        <p className="font-semibold text-brand-gray-800 flex items-center"><JobIcon className="w-4 h-4 mr-2 text-brand-gray-400"/> {job.id}</p>
                                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getStatusColor(job.status)}`}>
                                            {job.status}
                                        </span>
                                    </div>
                                    <p className="text-sm text-brand-gray-600 mt-1">{job.customerName}</p>
                                </div>
                            )) : (
                                <div className="text-center py-10">
                                    <p className="text-sm text-brand-gray-500">No active jobs to schedule.</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div className="flex-1 mt-8 lg:mt-0">
                    <div className="sm:flex sm:items-center sm:justify-between mb-4 space-y-4 sm:space-y-0">
                        <div className="flex items-center justify-center space-x-2">
                            {getNavigationControls()}
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2">
                            <button 
                                onClick={() => setShowTemplateSelector(true)}
                                className="inline-flex items-center gap-x-1.5 rounded-md bg-brand-cyan-600 px-2.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-cyan-700"
                            >
                                Create from Template
                            </button>
                            <button 
                                onClick={goToToday}
                                className="inline-flex items-center gap-x-1.5 rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-brand-gray-900 shadow-sm ring-1 ring-inset ring-brand-gray-300 hover:bg-brand-gray-50"
                            >
                                Today
                            </button>
                            <button 
                                onClick={handleSyncCalendar} 
                                disabled={isSyncing} 
                                className="inline-flex items-center gap-x-1.5 rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-brand-gray-900 shadow-sm ring-1 ring-inset ring-brand-gray-300 hover:bg-brand-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isSyncing ? <SpinnerIcon className="h-5 w-5" /> : <GoogleCalendarIcon className="h-5 w-5" />}
                                {isSyncing ? 'Syncing...' : 'Sync'}
                            </button>
                        </div>
                    </div>

                    <div className="mb-4 bg-white rounded-lg shadow-sm p-2 overflow-x-auto">
                        <div className="inline-flex space-x-1 min-w-min">
                            <button
                                onClick={() => setActiveView('day')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                    activeView === 'day'
                                        ? 'bg-brand-cyan-600 text-white'
                                        : 'text-brand-gray-700 hover:bg-brand-gray-100'
                                }`}
                            >
                                Day
                            </button>
                            <button
                                onClick={() => setActiveView('3-day')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                    activeView === '3-day' 
                                        ? 'bg-brand-cyan-600 text-white' 
                                        : 'text-brand-gray-700 hover:bg-brand-gray-100'
                                }`}
                            >
                                3-Day
                            </button>
                            <button
                                onClick={() => setActiveView('week')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                    activeView === 'week' 
                                        ? 'bg-brand-cyan-600 text-white' 
                                        : 'text-brand-gray-700 hover:bg-brand-gray-100'
                                }`}
                            >
                                Week
                            </button>
                            <button
                                onClick={() => setActiveView('month')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                    activeView === 'month' 
                                        ? 'bg-brand-cyan-600 text-white' 
                                        : 'text-brand-gray-700 hover:bg-brand-gray-100'
                                }`}
                            >
                                Month
                            </button>
                            <button
                                onClick={() => setActiveView('list')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                    activeView === 'list' 
                                        ? 'bg-brand-cyan-600 text-white' 
                                        : 'text-brand-gray-700 hover:bg-brand-gray-100'
                                }`}
                            >
                                List
                            </button>
                            <button
                                onClick={() => setActiveView('map')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                    activeView === 'map' 
                                        ? 'bg-brand-cyan-600 text-white' 
                                        : 'text-brand-gray-700 hover:bg-brand-gray-100'
                                }`}
                            >
                                Map
                            </button>
                            <button
                                onClick={() => setActiveView('crew')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                                    activeView === 'crew' 
                                        ? 'bg-brand-cyan-600 text-white' 
                                        : 'text-brand-gray-700 hover:bg-brand-gray-100'
                                }`}
                            >
                                Crew
                            </button>
                        </div>
                    </div>

                    <div className="mb-6 space-y-4">
                        {aiLoading && (
                            <div className="rounded-md border border-brand-gray-200 bg-white p-3 text-sm text-brand-gray-700 shadow-sm">
                                Calibrating AI schedule insights…
                            </div>
                        )}

                        <AiInsightsPanel
                            title="AI scheduling assistant"
                            subtitle={`Suggestions for ${currentDateString}`}
                            items={aiInsightItems}
                            icon="sparkles"
                        />

                        {aiError && (
                            <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
                                {aiError}
                            </div>
                        )}

                        {aiPredictions.length > 0 && (
                            <div className="bg-white rounded-lg border border-brand-gray-200 shadow-sm p-4">
                                <div className="flex items-start justify-between">
                                    <div>
                                        <h3 className="text-base font-semibold text-brand-gray-900">Job duration predictions</h3>
                                        <p className="text-sm text-brand-gray-600">Top jobs with AI-estimated durations and drivers.</p>
                                    </div>
                                    <span className="rounded-full bg-brand-gray-50 px-3 py-1 text-[11px] font-medium text-brand-gray-600">Beta</span>
                                </div>

                                <div className="mt-3 divide-y divide-brand-gray-100">
                                    {aiPredictions.slice(0, 4).map(prediction => {
                                        const job = jobLookup.get(prediction.jobId);
                                        return (
                                            <div key={prediction.jobId} className="py-3 flex items-start justify-between">
                                                <div>
                                                    <p className="text-sm font-semibold text-brand-gray-900">{job?.title || job?.id || 'Job'}</p>
                                                    <p className="text-xs text-brand-gray-600">{job?.customerName || 'Customer TBD'}</p>
                                                    {prediction.drivers && prediction.drivers.length > 0 && (
                                                        <p className="mt-1 text-xs text-brand-gray-500">Drivers: {prediction.drivers.slice(0, 2).join(', ')}</p>
                                                    )}
                                                </div>
                                                <div className="text-right">
                                                    <p className="text-lg font-bold text-brand-cyan-700">~{prediction.predictedMinutes}m</p>
                                                    <p className="text-[11px] text-brand-gray-500">{Math.round(prediction.confidence * 100)}% confidence</p>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="mb-6 bg-white rounded-lg border border-brand-gray-200 shadow-sm p-4">
                        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                            <div>
                                <h3 className="text-base font-semibold text-brand-gray-900">Operations intelligence</h3>
                                <p className="text-sm text-brand-gray-600">Weather, routing, and crew capacity insights for this week.</p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <select
                                    value={selectedCrewId}
                                    onChange={(e) => {
                                        setSelectedCrewId(e.target.value);
                                        setRoutePlan(null);
                                        setDispatchResult(null);
                                    }}
                                    className="rounded-md border-brand-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-cyan-500 focus:outline-none focus:ring-brand-cyan-500"
                                >
                                    <option value="">All crews</option>
                                    {crews.map(crew => (
                                        <option key={crew.id} value={crew.id}>{crew.name}</option>
                                    ))}
                                </select>
                                <button
                                    onClick={handleOptimizeRoute}
                                    disabled={routeLoading}
                                    className="inline-flex items-center rounded-md border border-brand-gray-300 bg-white px-3 py-2 text-sm font-medium text-brand-gray-700 shadow-sm hover:bg-brand-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {routeLoading ? (
                                        <>
                                            <SpinnerIcon className="mr-2 h-4 w-4 animate-spin" /> Optimizing…
                                        </>
                                    ) : (
                                        'Optimize route'
                                    )}
                                </button>
                                <button
                                    onClick={handleDispatchCrew}
                                    disabled={dispatchLoading}
                                    className="inline-flex items-center rounded-md bg-brand-cyan-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {dispatchLoading ? 'Building digest…' : 'Dispatch digest'}
                                </button>
                            </div>
                        </div>

                        {opsError && (
                            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{opsError}</div>
                        )}

                        <div className="mt-4 grid gap-4 lg:grid-cols-3">
                            <div className="rounded-md border border-brand-gray-100 bg-brand-gray-50 p-3">
                                <h4 className="text-sm font-semibold text-brand-gray-800">Weather watch</h4>
                                {opsLoading && weatherInsights.length === 0 ? (
                                    <p className="mt-2 text-sm text-brand-gray-600">Loading latest forecast…</p>
                                ) : weatherToDisplay.length === 0 ? (
                                    <p className="mt-2 text-sm text-brand-gray-600">No weather risks detected this week.</p>
                                ) : (
                                    <ul className="mt-2 space-y-2">
                                        {weatherToDisplay.map(item => (
                                            <li key={item.jobId} className="rounded-md bg-white p-2 shadow-sm">
                                                <div className="flex items-center justify-between text-xs text-brand-gray-500">
                                                    <span>{item.scheduledDate}</span>
                                                    <span className={
                                                        item.riskLevel === 'high'
                                                            ? 'font-semibold text-red-600'
                                                            : item.riskLevel === 'medium'
                                                                ? 'font-semibold text-orange-600'
                                                                : 'font-semibold text-brand-gray-600'
                                                    }>
                                                        {item.riskLevel.toUpperCase()}
                                                    </span>
                                                </div>
                                                <p className="mt-1 text-sm font-medium text-brand-gray-900">{item.customerName}</p>
                                                <p className="text-xs text-brand-gray-600">{item.condition} • {Math.round(item.precipProbability)}% precip • {Math.round(item.windMph)} mph wind</p>
                                                <p className="mt-1 text-xs text-brand-gray-700">{item.recommendation}</p>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            <div className="rounded-md border border-brand-gray-100 bg-brand-gray-50 p-3">
                                <h4 className="text-sm font-semibold text-brand-gray-800">Route summary</h4>
                                {routePlan ? (
                                    <div className="mt-2 space-y-2 text-sm text-brand-gray-700">
                                        <p>
                                            {routePlan.stops.length} stops • {routePlan.totalDistanceMiles.toFixed(1)} mi drive • {Math.round(routePlan.totalDriveMinutes)} min travel
                                        </p>
                                        <ul className="space-y-1 text-xs">
                                            {routePlan.stops.slice(0, 3).map(stop => (
                                                <li key={stop.jobId} className="rounded bg-white px-2 py-1 shadow-sm">
                                                    <span className="font-semibold">#{stop.order}</span> {stop.customerName} — ETA {stop.arrivalTimeLocal}
                                                </li>
                                            ))}
                                        </ul>
                                        {routePlan.stops.length > 3 && (
                                            <p className="text-xs text-brand-gray-500">…and {routePlan.stops.length - 3} more stops</p>
                                        )}
                                        {routePlan.warnings && routePlan.warnings.length > 0 && (
                                            <ul className="space-y-1 text-xs text-orange-600">
                                                {routePlan.warnings.map((warning, idx) => (
                                                    <li key={idx}>⚠️ {warning}</li>
                                                ))}
                                            </ul>
                                        )}
                                        <div className="flex flex-wrap gap-2 pt-1">
                                            <button
                                                onClick={() => setIsRouteDrawerOpen(true)}
                                                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-white bg-brand-cyan-600 rounded-md hover:bg-brand-cyan-700"
                                            >
                                                View optimized route
                                            </button>
                                            <button
                                                onClick={handleOptimizeRoute}
                                                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-brand-gray-700 bg-white border border-brand-gray-300 rounded-md hover:bg-brand-gray-100"
                                            >
                                                Re-run optimizer
                                            </button>
                                        </div>
                                    </div>
                                ) : routeLoading ? (
                                    <p className="mt-2 text-sm text-brand-gray-600">Optimizing route…</p>
                                ) : (
                                    <p className="mt-2 text-sm text-brand-gray-600">Run optimization to see the ideal stop order.</p>
                                )}
                            </div>

                            <div className="rounded-md border border-brand-gray-100 bg-brand-gray-50 p-3">
                                <h4 className="text-sm font-semibold text-brand-gray-800">Crew availability</h4>
                                {opsLoading && availabilitySummaries.length === 0 ? (
                                    <p className="mt-2 text-sm text-brand-gray-600">Checking capacity…</p>
                                ) : availabilityToDisplay.length === 0 ? (
                                    <p className="mt-2 text-sm text-brand-gray-600">No crew capacity signals this week.</p>
                                ) : (
                                    <ul className="mt-2 space-y-2 text-xs text-brand-gray-700">
                                        {availabilityToDisplay.map(item => (
                                            <li key={`${item.crewId}-${item.date}`} className="rounded bg-white px-2 py-1 shadow-sm">
                                                <div className="flex items-center justify-between">
                                                    <span className="font-semibold">{item.crewName}</span>
                                                    <span className={
                                                        item.status === 'overbooked'
                                                            ? 'text-red-600'
                                                            : item.status === 'tight'
                                                                ? 'text-orange-600'
                                                                : 'text-brand-gray-600'
                                                    }>
                                                        {item.availableHours.toFixed(1)}h free
                                                    </span>
                                                </div>
                                                <p>{item.date}</p>
                                                <p>Utilization {Math.round(item.utilizationPercentage)}%</p>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>

                        {dispatchResult && (
                            <div className="mt-4 rounded-md border border-brand-gray-100 bg-brand-gray-50 p-3">
                                <h4 className="text-sm font-semibold text-brand-gray-800">Dispatch digest</h4>
                                <p className="mt-1 text-sm text-brand-gray-700">{dispatchResult.summary}</p>
                                <ul className="mt-2 space-y-1 text-xs text-brand-gray-600">
                                    {dispatchResult.notifications.slice(0, 4).map((notification, index) => (
                                        <li key={`${notification.jobId}-${index}`} className="rounded bg-white px-2 py-1 shadow-sm">
                                            {notification.scheduledAt.split('T')[0]} • {notification.message}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>

                    {activeView !== 'list' && activeView !== 'map' && activeView !== 'crew' && (
                        <div className="mb-4 flex flex-wrap gap-2">
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                                className="rounded-md border-brand-gray-300 shadow-sm focus:border-brand-cyan-500 focus:ring-brand-cyan-500 text-sm"
                            >
                                <option value="all">All Statuses</option>
                                <option value="Unscheduled">Unscheduled</option>
                                <option value="Scheduled">Scheduled</option>
                                <option value="In Progress">In Progress</option>
                            </select>
                            <select 
                                value={employeeFilter} 
                                onChange={(e) => setEmployeeFilter(e.target.value)}
                                className="rounded-md border-brand-gray-300 shadow-sm focus:border-brand-cyan-500 focus:ring-brand-cyan-500 text-sm"
                            >
                                <option value="all">All Employees</option>
                                {employees.map(emp => (
                                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {activeView === 'month' && <MonthView {...viewProps} />}
                    {activeView === 'week' && <WeekView {...viewProps} />}
                    {activeView === 'day' && <DayView {...viewProps} />}
                    {activeView === '3-day' && <ThreeDayView {...viewProps} />}
                    {activeView === 'list' && <ListView {...viewProps} />}
                    {activeView === 'map' && (
                        <MapViewWrapper
                            {...viewProps}
                            customers={customers}
                            routePlan={routePlan}
                            onOpenRoutePlan={() => setIsRouteDrawerOpen(true)}
                            onOpenChat={handleOpenDispatcherChat}
                        />
                    )}
                    {activeView === 'crew' && <CrewView jobs={jobs} currentDate={currentDate} refetchJobs={refetchJobs} onJobDrop={viewProps.onJobDrop} handleDragStart={handleDragStart} handleDragEnd={handleDragEnd} draggedJobId={draggedJobId} />}
                </div>
            </div>

            <TemplateSelector
                isOpen={showTemplateSelector}
                onClose={() => setShowTemplateSelector(false)}
                onSelect={handleUseTemplate}
            />

            <RoutePlanDrawer
                isOpen={isRouteDrawerOpen}
                routePlan={routePlan}
                onClose={() => setIsRouteDrawerOpen(false)}
                onReorder={handleReorderStop}
                onNotify={handleOnMyWay}
                onReoptimize={handleOptimizeRoute}
                onReorderList={handleReorderStopsList}
                onOpenChat={handleOpenDispatcherChat}
            />
        </div>
    );
};

export default Calendar;