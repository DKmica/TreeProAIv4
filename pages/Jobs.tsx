import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Job, Quote, Invoice, Employee, LineItem, JobCost, PortalMessage, CustomerDetailsInput } from '../types';
import ClipboardSignatureIcon from '../components/icons/ClipboardSignatureIcon';
import ChatBubbleLeftRightIcon from '../components/icons/ChatBubbleLeftRightIcon';
import { Download, Mail } from 'lucide-react';
import PortalMessaging from '../components/PortalMessaging';
import JobStatusBadge from '../components/JobStatusBadge';
import StateTransitionControl from '../components/StateTransitionControl';
import StateHistoryTimeline from '../components/StateHistoryTimeline';
import XIcon from '../components/icons/XIcon';
import TemplateSelector from '../components/TemplateSelector';
import JobForms from '../components/JobForms';
import InvoiceEditor from '../components/InvoiceEditor';
import { generateJobRiskAssessment } from '../services/geminiService';
import * as api from '../services/apiService';
import AssociationModal from '../components/AssociationModal';
import RecurringJobsPanel from '../components/RecurringJobsPanel';
import { formatPhone, formatZip, parseEquipment, lookupZipCode } from '../utils/formatters';
import StateSelect from '../components/ui/StateSelect';
import { useJobsQuery, useQuotesQuery, useInvoicesQuery, useEmployeesQuery } from '../hooks/useDataQueries';

// Helper to calculate total
const calculateQuoteTotal = (lineItems: LineItem[], stumpGrindingPrice: number): number => {
    const itemsTotal = lineItems.reduce((sum, item) => item.selected ? sum + item.price : sum, 0);
    return itemsTotal + (stumpGrindingPrice || 0);
};

interface NewCustomerData {
    companyName: string;
    firstName: string;
    lastName: string;
    phone: string;
    email: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    zipCode: string;
}

interface JobLocationData {
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    zipCode: string;
}

// Common form component for adding and editing jobs
const JobForm: React.FC<{
    quotes: Quote[];
    employees: Employee[];
    onSave: (job: Job | Omit<Job, 'id'>) => Promise<void>;
    onCancel: () => void;
    initialData?: Job;
}> = ({ quotes, employees, onSave, onCancel, initialData }) => {
    const availableQuotes = quotes.filter(q => q.status === 'Accepted'); 
    
    const [formData, setFormData] = useState({
        id: initialData?.id || '',
        quoteId: initialData?.quoteId || (availableQuotes.length > 0 ? availableQuotes[0].id : ''),
        customerName: initialData?.customerName || (availableQuotes.length > 0 ? availableQuotes[0].customerName : ''),
        customerPhone: initialData?.customerPhone || '',
        customerEmail: initialData?.customerEmail || '',
        customerAddress: initialData?.customerAddress || '',
        scheduledDate: initialData?.scheduledDate || '',
        status: initialData?.status || ('draft' as Job['status']),
        assignedCrew: initialData?.assignedCrew || [],
        jobLocation: initialData?.jobLocation || '',
        specialInstructions: initialData?.specialInstructions || '',
        equipmentNeeded: initialData?.equipmentNeeded || [],
        estimatedHours: initialData?.estimatedHours ? initialData.estimatedHours.toString() : '',
    });

    const [jobLocationData, setJobLocationData] = useState<JobLocationData>({
        addressLine1: '',
        addressLine2: '',
        city: '',
        state: '',
        zipCode: '',
    });

    const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');
    const [newCustomerData, setNewCustomerData] = useState<NewCustomerData>({
        companyName: '',
        firstName: '',
        lastName: '',
        phone: '',
        email: '',
        addressLine1: '',
        addressLine2: '',
        city: '',
        state: '',
        zipCode: '',
    });
    const [errors, setErrors] = useState<{[key: string]: string}>({});
    const [equipmentText, setEquipmentText] = useState<string>(
        initialData?.equipmentNeeded?.join(', ') || ''
    );

    useEffect(() => {
        if (initialData) {
            setFormData({
                id: initialData.id,
                quoteId: initialData.quoteId,
                customerName: initialData.customerName,
                customerPhone: initialData.customerPhone || '',
                customerEmail: initialData.customerEmail || '',
                customerAddress: initialData.customerAddress || '',
                scheduledDate: initialData.scheduledDate,
                status: initialData.status,
                assignedCrew: initialData.assignedCrew,
                jobLocation: initialData.jobLocation || '',
                specialInstructions: initialData.specialInstructions || '',
                equipmentNeeded: initialData.equipmentNeeded || [],
                estimatedHours: initialData.estimatedHours || 0,
            });
            setEquipmentText(initialData.equipmentNeeded?.join(', ') || '');
            setCustomerMode(initialData.quoteId ? 'existing' : 'new');
        } else {
            const defaultQuote = availableQuotes.length > 0 ? availableQuotes[0] : null;
            setFormData({
                id: '',
                quoteId: defaultQuote?.id || '',
                customerName: defaultQuote?.customerName || '',
                customerPhone: '',
                customerEmail: '',
                customerAddress: '',
                scheduledDate: '',
                status: 'draft',
                assignedCrew: [],
                jobLocation: '',
                specialInstructions: '',
                equipmentNeeded: [],
                estimatedHours: 0,
            });
            setEquipmentText('');
            setCustomerMode('existing');
            setNewCustomerData({
                companyName: '',
                firstName: '',
                lastName: '',
                phone: '',
                email: '',
                addressLine1: '',
                addressLine2: '',
                city: '',
                state: '',
                zipCode: '',
            });
        }
        setErrors({});
    }, [initialData, quotes]);

    const [lastFetchedQuoteId, setLastFetchedQuoteId] = React.useState<string>('');
    
    useEffect(() => {
        const fetchQuoteDetails = async () => {
            if (!formData.quoteId || formData.quoteId === lastFetchedQuoteId || quotes.length === 0) {
                return;
            }
            
            const selectedQuote = quotes.find(q => q.id === formData.quoteId);
            if (!selectedQuote?.clientId) {
                console.log('No clientId found for quote:', formData.quoteId, 'selectedQuote:', selectedQuote);
                return;
            }
            
            try {
                // Fetch client for customer contact info
                const client = await api.clientService.getById(selectedQuote.clientId);
                const phone = client.primaryPhone || '';
                const email = client.primaryEmail || '';
                const address = [
                    client.billingAddressLine1,
                    client.billingCity,
                    client.billingState,
                    (client as any).billingZipCode || client.billingZip
                ].filter(Boolean).join(', ') || '';
                
                setFormData(prev => ({
                    ...prev,
                    customerPhone: phone,
                    customerEmail: email,
                    customerAddress: address
                }));
                
                // Fetch property for job location
                if (selectedQuote.propertyId) {
                    const property = await api.propertyService.getById(selectedQuote.propertyId);
                    setJobLocationData({
                        addressLine1: property.addressLine1 || '',
                        addressLine2: property.addressLine2 || '',
                        city: property.city || '',
                        state: property.state || '',
                        zipCode: property.zipCode || '',
                    });
                }
                
                setLastFetchedQuoteId(formData.quoteId);
            } catch (e) {
                console.error('Failed to fetch quote details:', e);
            }
        };
        fetchQuoteDetails();
    }, [formData.quoteId, quotes, lastFetchedQuoteId]);
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        if (name === 'quoteId') {
            const selectedQuote = quotes.find(q => q.id === value);
            setFormData(prev => ({
                ...prev,
                quoteId: selectedQuote ? selectedQuote.id : '',
                customerName: selectedQuote ? selectedQuote.customerName : '',
            }));
            // Extract address from quote's property if available
            if (selectedQuote?.property) {
                setJobLocationData({
                    addressLine1: selectedQuote.property.addressLine1 || '',
                    addressLine2: selectedQuote.property.addressLine2 || '',
                    city: selectedQuote.property.city || '',
                    state: selectedQuote.property.state || '',
                    zipCode: selectedQuote.property.zipCode || '',
                });
            }
        } else {
            setFormData(prev => ({ ...prev, [name]: value as any }));
        }
        if (errors[name]) {
            setErrors(prev => ({ ...prev, [name]: '' }));
        }
    };

    const handleJobLocationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        let formattedValue = value;
        
        if (name === 'phone') {
            formattedValue = formatPhone(value);
        } else if (name === 'zipCode') {
            formattedValue = formatZip(value);
        } else if (name === 'state') {
            formattedValue = value.toString().toUpperCase();
        }
        
        setJobLocationData(prev => ({ ...prev, [name]: formattedValue }));
        if (errors[name]) {
            setErrors(prev => ({ ...prev, [name]: '' }));
        }
    };

    const handleNewCustomerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        let formattedValue = value;
        
        if (name === 'phone') {
            formattedValue = formatPhone(value);
        } else if (name === 'zipCode') {
            formattedValue = formatZip(value);
        } else if (name === 'state') {
            formattedValue = value.toString().toUpperCase();
        }
        
        setNewCustomerData(prev => ({ ...prev, [name]: formattedValue }));
        if (errors[name]) {
            setErrors(prev => ({ ...prev, [name]: '' }));
        }
    };

    const handleCustomerModeChange = (mode: 'existing' | 'new') => {
        setCustomerMode(mode);
        if (mode === 'new') {
            setFormData(prev => ({ 
                ...prev, 
                quoteId: '', 
                customerName: ''
            }));
        }
    };
    
    const handleCrewChange = (employeeId: string) => {
        setFormData(prev => ({
            ...prev,
            assignedCrew: prev.assignedCrew.includes(employeeId)
                ? prev.assignedCrew.filter(id => id !== employeeId)
                : [...prev.assignedCrew, employeeId]
        }));
    };

    const validateForm = (): boolean => {
        const newErrors: {[key: string]: string} = {};

        if (customerMode === 'existing') {
            if (!formData.quoteId) {
                newErrors.quoteId = 'Please select a quote';
            }
        } else {
            if (!newCustomerData.firstName.trim()) {
                newErrors.firstName = 'First name is required';
            }
            if (!newCustomerData.lastName.trim()) {
                newErrors.lastName = 'Last name is required';
            }
            if (!newCustomerData.phone.trim()) {
                newErrors.phone = 'Phone number is required';
            }
            if (!newCustomerData.email.trim()) {
                newErrors.email = 'Email address is required';
            }
            if (!newCustomerData.addressLine1.trim()) {
                newErrors.addressLine1 = 'Address is required';
            }
            if (!newCustomerData.city.trim()) {
                newErrors.city = 'City is required';
            }
            if (!newCustomerData.state.trim()) {
                newErrors.state = 'State is required';
            }
            if (!newCustomerData.zipCode.trim()) {
                newErrors.zipCode = 'Zip code is required';
            }
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!validateForm()) {
            return;
        }

        try {
            let clientId: string | undefined;
            let customerDetails: CustomerDetailsInput | undefined;
            let customerName = formData.customerName;

            if (customerMode === 'existing') {
                const selectedQuote = quotes.find(q => q.id === formData.quoteId);
                clientId = selectedQuote?.clientId;
                if (!clientId) {
                    alert('Selected quote is missing client information.');
                    return;
                }
            } else {
                customerDetails = {
                    firstName: newCustomerData.firstName,
                    lastName: newCustomerData.lastName,
                    companyName: newCustomerData.companyName || undefined,
                    phone: newCustomerData.phone,
                    email: newCustomerData.email,
                    addressLine1: newCustomerData.addressLine1,
                    addressLine2: newCustomerData.addressLine2 || undefined,
                    city: newCustomerData.city,
                    state: newCustomerData.state,
                    zipCode: newCustomerData.zipCode,
                    country: 'USA'
                };
                customerName = newCustomerData.companyName || `${newCustomerData.firstName} ${newCustomerData.lastName}`;
            }

            const jobData: Partial<Job> & { customerDetails?: CustomerDetailsInput } = {
                ...formData,
                customerName,
                equipmentNeeded: parseEquipment(equipmentText),
            };

            if (clientId) {
                jobData.clientId = clientId;
            }
            if (customerDetails) {
                jobData.customerDetails = customerDetails;
            }

            await onSave(jobData as Job | Omit<Job, 'id'>);
        } catch (error: any) {
            alert(`Failed to create customer/job: ${error.message || 'Unknown error'}`);
        }
    };

    return (
        <div className="bg-[#0f1c2e] p-6 rounded-lg shadow my-6 border border-gray-700">
            <h2 className="text-xl font-bold text-white mb-4">{initialData ? 'Edit Job' : 'Create New Job'}</h2>
            <form onSubmit={handleSubmit}>
                <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
                    <div className="col-span-full">
                        <label className="block text-sm font-medium leading-6 text-gray-300 mb-2">Customer Source *</label>
                        <div className="flex gap-6">
                            <label className="flex items-center cursor-pointer">
                                <input
                                    type="radio"
                                    name="customerMode"
                                    value="existing"
                                    checked={customerMode === 'existing'}
                                    onChange={(e) => handleCustomerModeChange(e.target.value as 'existing' | 'new')}
                                    className="mr-2 text-cyan-500 focus:ring-cyan-500"
                                />
                                <span className="text-gray-300">From Accepted Quote</span>
                            </label>
                            <label className="flex items-center cursor-pointer">
                                <input
                                    type="radio"
                                    name="customerMode"
                                    value="new"
                                    checked={customerMode === 'new'}
                                    onChange={(e) => handleCustomerModeChange(e.target.value as 'existing' | 'new')}
                                    className="mr-2 text-cyan-500 focus:ring-cyan-500"
                                />
                                <span className="text-gray-300">Create New Customer</span>
                            </label>
                        </div>
                    </div>

                    {customerMode === 'existing' ? (
                        <>

                            <div className="sm:col-span-3">
                                <label htmlFor="quoteId" className="block text-sm font-medium leading-6 text-gray-300">Accepted Quote *</label>
                                <select id="quoteId" name="quoteId" value={formData.quoteId} onChange={handleChange} className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6">
                                    <option value="">Select a quote...</option>
                                    {availableQuotes.map(quote => (<option key={quote.id} value={quote.id}>{`${quote.id} - ${quote.customerName}`}</option>))}
                                </select>
                                {errors.quoteId && <p className="mt-1 text-sm text-red-400">{errors.quoteId}</p>}
                            </div>
                            <div className="sm:col-span-3">
                                <label htmlFor="customerName" className="block text-sm font-medium leading-6 text-gray-300">Customer</label>
                                <input type="text" name="customerName" id="customerName" value={formData.customerName} readOnly className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-gray-400 shadow-sm ring-1 ring-inset ring-gray-600 focus:ring-0 sm:text-sm sm:leading-6" />
                            </div>
                            <div className="sm:col-span-3">
                                <label className="block text-sm font-medium leading-6 text-gray-300">Customer Phone</label>
                                <input type="text" value={formData.customerPhone} readOnly className="block w-full rounded-md border-0 py-1.5 bg-gray-700 text-gray-400 shadow-sm ring-1 ring-inset ring-gray-600 sm:text-sm sm:leading-6" />
                            </div>
                            <div className="sm:col-span-3">
                                <label className="block text-sm font-medium leading-6 text-gray-300">Customer Email</label>
                                <input type="text" value={formData.customerEmail} readOnly className="block w-full rounded-md border-0 py-1.5 bg-gray-700 text-gray-400 shadow-sm ring-1 ring-inset ring-gray-600 sm:text-sm sm:leading-6" />
                            </div>
                            <div className="sm:col-span-6">
                                <label className="block text-sm font-medium leading-6 text-gray-300">Customer Address</label>
                                <input type="text" value={formData.customerAddress} readOnly className="block w-full rounded-md border-0 py-1.5 bg-gray-700 text-gray-400 shadow-sm ring-1 ring-inset ring-gray-600 sm:text-sm sm:leading-6" />
                            </div>
                        </>
                    ) : (
                        <div className="col-span-full p-4 bg-gray-800/50 rounded-lg border border-gray-700">
                            <h3 className="text-lg font-semibold text-white mb-4">New Customer Information</h3>
                            

                            <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-6">
                                <div className="col-span-full">
                                    <label htmlFor="companyName" className="block text-sm font-medium leading-6 text-gray-300">Company Name (Optional)</label>
                                    <input
                                        type="text"
                                        id="companyName"
                                        name="companyName"
                                        value={newCustomerData.companyName}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="Enter company name"
                                    />
                                </div>

                                <div className="sm:col-span-3">
                                    <label htmlFor="firstName" className="block text-sm font-medium leading-6 text-gray-300">First Name *</label>
                                    <input
                                        type="text"
                                        id="firstName"
                                        name="firstName"
                                        value={newCustomerData.firstName}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="First name"
                                    />
                                    {errors.firstName && <p className="mt-1 text-sm text-red-400">{errors.firstName}</p>}
                                </div>

                                <div className="sm:col-span-3">
                                    <label htmlFor="lastName" className="block text-sm font-medium leading-6 text-gray-300">Last Name *</label>
                                    <input
                                        type="text"
                                        id="lastName"
                                        name="lastName"
                                        value={newCustomerData.lastName}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="Last name"
                                    />
                                    {errors.lastName && <p className="mt-1 text-sm text-red-400">{errors.lastName}</p>}
                                </div>

                                <div className="sm:col-span-3">
                                    <label htmlFor="phone" className="block text-sm font-medium leading-6 text-gray-300">Phone Number *</label>
                                    <input
                                        type="tel"
                                        id="phone"
                                        name="phone"
                                        value={newCustomerData.phone}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="(555) 123-4567"
                                    />
                                    {errors.phone && <p className="mt-1 text-sm text-red-400">{errors.phone}</p>}
                                </div>

                                <div className="sm:col-span-3">
                                    <label htmlFor="email" className="block text-sm font-medium leading-6 text-gray-300">Email Address *</label>
                                    <input
                                        type="email"
                                        id="email"
                                        name="email"
                                        value={newCustomerData.email}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="email@example.com"
                                    />
                                    {errors.email && <p className="mt-1 text-sm text-red-400">{errors.email}</p>}
                                </div>

                                <div className="col-span-full">
                                    <label htmlFor="addressLine1" className="block text-sm font-medium leading-6 text-gray-300">Address Line 1 *</label>
                                    <input
                                        type="text"
                                        id="addressLine1"
                                        name="addressLine1"
                                        value={newCustomerData.addressLine1}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="Street address"
                                    />
                                    {errors.addressLine1 && <p className="mt-1 text-sm text-red-400">{errors.addressLine1}</p>}
                                </div>

                                <div className="col-span-full">
                                    <label htmlFor="addressLine2" className="block text-sm font-medium leading-6 text-gray-300">Address Line 2 (Optional)</label>
                                    <input
                                        type="text"
                                        id="addressLine2"
                                        name="addressLine2"
                                        value={newCustomerData.addressLine2}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="Apt, suite, unit, etc."
                                    />
                                </div>

                                <div className="sm:col-span-2">
                                    <label htmlFor="city" className="block text-sm font-medium leading-6 text-gray-300">City *</label>
                                    <input
                                        type="text"
                                        id="city"
                                        name="city"
                                        value={newCustomerData.city}
                                        onChange={handleNewCustomerChange}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="City"
                                    />
                                    {errors.city && <p className="mt-1 text-sm text-red-400">{errors.city}</p>}
                                </div>

                                <div className="sm:col-span-2">
                                    <label htmlFor="state" className="block text-sm font-medium leading-6 text-gray-300">State *</label>
                                    <StateSelect
                                        id="state"
                                        name="state"
                                        value={newCustomerData.state}
                                        onChange={(value) => {
                                            setNewCustomerData(prev => ({ ...prev, state: value }));
                                            if (errors.state) {
                                                setErrors(prev => ({ ...prev, state: '' }));
                                            }
                                        }}
                                        required
                                        className="block w-full rounded-md border-0 py-1.5 shadow-sm ring-1 ring-inset ring-gray-600 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                    />
                                    {errors.state && <p className="mt-1 text-sm text-red-400">{errors.state}</p>}
                                </div>

                                <div className="sm:col-span-2">
                                    <label htmlFor="zipCode" className="block text-sm font-medium leading-6 text-gray-300">Zip Code *</label>
                                    <input
                                        type="text"
                                        id="zipCode"
                                        name="zipCode"
                                        value={newCustomerData.zipCode}
                                        onChange={(e) => {
                                            const zip = formatZip(e.target.value);
                                            handleNewCustomerChange({ target: { name: 'zipCode', value: zip } } as any);
                                            if (zip.length === 5) {
                                                const lookup = lookupZipCode(zip);
                                                if (lookup) {
                                                    handleNewCustomerChange({ target: { name: 'city', value: lookup.city } } as any);
                                                    handleNewCustomerChange({ target: { name: 'state', value: lookup.state } } as any);
                                                }
                                            }
                                        }}
                                        maxLength={5}
                                        className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                        placeholder="12345"
                                    />
                                    {errors.zipCode && <p className="mt-1 text-sm text-red-400">{errors.zipCode}</p>}
                                </div>
                            </div>
                            

                            <button
                                type="button"
                                onClick={() => {
                                    setJobLocationData({
                                        addressLine1: newCustomerData.addressLine1,
                                        addressLine2: newCustomerData.addressLine2,
                                        city: newCustomerData.city,
                                        state: newCustomerData.state,
                                        zipCode: newCustomerData.zipCode,
                                    });
                                }}
                                className="mt-3 w-full px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-md text-sm font-medium transition-colors"
                            >
                                Use as Job Location
                            </button>
                        </div>
                    )}
                    <div className="sm:col-span-3">
                        <label htmlFor="scheduledDate" className="block text-sm font-medium leading-6 text-gray-300">Scheduled Date</label>
                        <input type="date" name="scheduledDate" id="scheduledDate" value={formData.scheduledDate} onChange={handleChange} className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" />
                    </div>
                    <div className="sm:col-span-3">
                        <label htmlFor="status" className="block text-sm font-medium leading-6 text-gray-300">Status</label>
                        <select id="status" name="status" value={formData.status} onChange={handleChange} className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6">
                            <option value="draft">Draft</option>
                            <option value="needs_permit">Needs Permit</option>
                            <option value="waiting_on_client">Waiting on Client</option>
                            <option value="scheduled">Scheduled</option>
                            <option value="en_route">En Route</option>
                            <option value="on_site">On Site</option>
                            <option value="weather_hold">Weather Hold</option>
                            <option value="in_progress">In Progress</option>
                            <option value="completed">Completed</option>
                            <option value="invoiced">Invoiced</option>
                            <option value="paid">Paid</option>
                            <option value="cancelled">Cancelled</option>
                        </select>
                    </div>
                    
                    <div className="col-span-full">
                        <h3 className="text-md font-semibold text-white mb-3">Job Location</h3>
                        <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-6">
                            <div className="col-span-full">
                                <label htmlFor="locationAddress1" className="block text-sm font-medium leading-6 text-gray-300">Street Address</label>
                                <input type="text" id="locationAddress1" name="addressLine1" value={jobLocationData.addressLine1} onChange={handleJobLocationChange} placeholder="123 Oak Street" className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" />
                            </div>
                            <div className="col-span-full">
                                <label htmlFor="locationAddress2" className="block text-sm font-medium leading-6 text-gray-300">Address Line 2 (Optional)</label>
                                <input type="text" id="locationAddress2" name="addressLine2" value={jobLocationData.addressLine2} onChange={handleJobLocationChange} placeholder="Apt, suite, etc." className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" />
                            </div>
                            <div className="sm:col-span-2">
                                <label htmlFor="locationCity" className="block text-sm font-medium leading-6 text-gray-300">City</label>
                                <input type="text" id="locationCity" name="city" value={jobLocationData.city} onChange={handleJobLocationChange} placeholder="Los Angeles" className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" />
                            </div>
                            <div className="sm:col-span-2">
                                <label htmlFor="locationState" className="block text-sm font-medium leading-6 text-gray-300">State</label>
                                <StateSelect
                                    id="locationState"
                                    name="state"
                                    value={jobLocationData.state}
                                    onChange={(value) => setJobLocationData(prev => ({ ...prev, state: value }))}
                                    className="block w-full rounded-md border-0 py-1.5 shadow-sm ring-1 ring-inset ring-gray-600 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6"
                                />
                            </div>
                            <div className="sm:col-span-2">
                                <label htmlFor="locationZip" className="block text-sm font-medium leading-6 text-gray-300">Zip Code</label>
                                <input type="text" id="locationZip" name="zipCode" value={jobLocationData.zipCode} onChange={handleJobLocationChange} maxLength={5} placeholder="90001" className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" />
                            </div>
                        </div>
                    </div>
                    <div className="sm:col-span-3">
                        <label htmlFor="estimatedHours" className="block text-sm font-medium leading-6 text-gray-300">Estimated Hours</label>
                        <input type="number" name="estimatedHours" id="estimatedHours" value={formData.estimatedHours} onChange={e => setFormData(prev => ({...prev, estimatedHours: e.target.value }))} min="0" step="0.5" className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" placeholder=" " />
                    </div>
                    <div className="sm:col-span-3">
                        <label htmlFor="equipmentNeeded" className="block text-sm font-medium leading-6 text-gray-300">Equipment Needed</label>
                        <input type="text" name="equipmentNeeded" id="equipmentNeeded" value={equipmentText} onChange={e => setEquipmentText(e.target.value)} onBlur={e => setFormData(prev => ({...prev, equipmentNeeded: parseEquipment(e.target.value) }))} placeholder="e.g. Chainsaw, Chipper, Stump Grinder" className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" />
                    </div>
                    <div className="col-span-full">
                        <label htmlFor="specialInstructions" className="block text-sm font-medium leading-6 text-gray-300">Special Instructions / Notes</label>
                        <textarea name="specialInstructions" id="specialInstructions" value={formData.specialInstructions} onChange={e => setFormData(prev => ({...prev, specialInstructions: e.target.value }))} rows={3} placeholder="Gate code, parking instructions, special considerations, etc." className="block w-full rounded-md border-0 py-1.5 bg-gray-800 text-white shadow-sm ring-1 ring-inset ring-gray-600 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-cyan-500 sm:text-sm sm:leading-6" />
                    </div>
                    <div className="col-span-full">
                        <label className="block text-sm font-medium leading-6 text-gray-300">Assign Crew</label>
                        <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-4 rounded-md border border-gray-600 bg-gray-800/50 p-4">
                            {employees.map(emp => (
                                <div key={emp.id} className="relative flex items-start">
                                    <div className="flex h-6 items-center">
                                        <input
                                            id={`emp-form-${emp.id}`}
                                            type="checkbox"
                                            checked={formData.assignedCrew.includes(emp.id)}
                                            onChange={() => handleCrewChange(emp.id)}
                                            className="h-4 w-4 rounded border-gray-600 text-cyan-600 focus:ring-cyan-500"
                                        />
                                    </div>
                                    <div className="ml-3 text-sm leading-6">
                                        <label htmlFor={`emp-form-${emp.id}`} className="font-medium text-gray-300">{emp.name}</label>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="mt-6 flex items-center justify-end gap-x-6">
                    <button type="button" onClick={onCancel} className="text-sm font-semibold leading-6 text-gray-300 hover:text-white">Cancel</button>
                    <button type="submit" className="rounded-md bg-cyan-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cyan-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500">Save Job</button>
                </div>
            </form>
        </div>
    );
};

const Jobs: React.FC = () => {
  const { data: jobs = [], isLoading: jobsLoading, refetch: refetchJobs } = useJobsQuery();
  const { data: quotes = [], isLoading: quotesLoading } = useQuotesQuery();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Jobs</h1>
      <JobForm
        quotes={quotes}
        employees={[]}
        onSave={() => {}}
        onCancel={() => {}}
        initialData={null}
      />
    </div>
  );
};

export default Jobs;