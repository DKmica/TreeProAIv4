import {
  DashboardIcon,
  UsersIcon,
  LeadIcon,
  QuoteIcon,
  JobIcon,
  CalendarIcon,
  InvoiceIcon,
  MapPinIcon,
  ToolIcon,
  ClockIcon,
  DollarIcon,
  MarketingIcon,
  AICoreIcon,
  CogIcon,
  DocumentTextIcon,
  ClipboardDocumentListIcon
} from '../../components/icons';

export const navigationConfig = [
  {
    group: 'Overview',
    items: [
      { name: 'Dashboard', href: '/dashboard', icon: DashboardIcon },
      { name: 'Calendar', href: '/calendar', icon: CalendarIcon },
      { name: 'Map View', href: '/calendar?view=map', icon: MapPinIcon },
    ]
  },
  {
    group: 'Sales & CRM',
    items: [
      { name: 'Leads', href: '/leads', icon: LeadIcon },
      { name: 'Quotes', href: '/quotes', icon: QuoteIcon },
      { name: 'Clients', href: '/customers', icon: UsersIcon },
    ]
  },
  {
    group: 'Operations',
    items: [
      { name: 'Jobs', href: '/jobs', icon: JobIcon },
      { name: 'Crews', href: '/crews', icon: UsersIcon },
      { name: 'Equipment', href: '/equipment', icon: ToolIcon },
      { name: 'Time Tracking', href: '/time-tracking', icon: ClockIcon },
    ]
  },
  {
    group: 'Finance',
    items: [
      { name: 'Invoices', href: '/invoices', icon: InvoiceIcon },
      { name: 'Payroll', href: '/payroll', icon: DollarIcon },
      { name: 'Profitability', href: '/profitability', icon: DollarIcon },
    ]
  },
  {
    group: 'Intelligence & Tools',
    items: [
      { name: 'AI Core', href: '/ai-core', icon: AICoreIcon },
      { name: 'Marketing', href: '/marketing', icon: MarketingIcon },
      { name: 'Job Templates', href: '/job-templates', icon: ClipboardDocumentListIcon },
      { name: 'Form Templates', href: '/forms', icon: DocumentTextIcon },
      { name: 'Settings', href: '/settings', icon: CogIcon },
    ]
  }
];