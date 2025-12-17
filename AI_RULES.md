# TreePro AI - Development Rules & Guidelines

> **Last Updated:** December 2024  
> **For AI Assistants & Developers**

---

## Tech Stack Overview

- **Frontend:** React 19 with TypeScript, Vite 6.4.1 for build tooling, and React Router DOM v6.30.1 for navigation
- **Styling:** TailwindCSS 3.4.18 with PostCSS plugin, using utility-first approach with custom design system colors
- **State Management:** React hooks, Context API, and TanStack Query v5.90.10 for server state management and caching
- **Backend:** Node.js with Express.js framework, providing RESTful API on port 3001 with PostgreSQL database
- **Database:** PostgreSQL 14+ with node-postgres driver, using UUID primary keys and soft deletes pattern
- **AI/ML:** Google Gemini API (@google/genai v1.27.0) with ChromaDB for vector embeddings and RAG implementation
- **Authentication:** Token-based API authentication with bcryptjs for password hashing and express-session for session management
- **Testing:** Vitest 4.0.10 for unit/integration tests, Playwright 1.56.1 for E2E testing, and React Testing Library for component tests
- **Payments:** Stripe v20.0.0 for payment processing with webhook handling and checkout sessions

---

## Library Usage Rules

### UI Components & Styling

**ALWAYS USE:**
- **TailwindCSS** for all styling - No inline styles, no CSS modules
- **Lucide React** icons - Import from `lucide-react`
- **shadcn/ui components** when available - Check `components/ui/` first
- **Responsive design** - Mobile-first approach with `sm:`, `md:`, `lg:` breakpoints

**NEVER USE:**
- Inline styles (`style={{}}`)
- CSS-in-JS libraries (styled-components, emotion)
- Bootstrap or other CSS frameworks
- Hard-coded colors - Use Tailwind color palette

### Forms & Inputs

**ALWAYS USE:**
- **FormCombobox** (`components/ui/FormCombobox.tsx`) for searchable dropdowns
- **FormInput**, **FormSelect**, **FormTextarea** from `components/ui/`
- **React Hook Form** patterns (see existing forms)
- **Zod** for validation schemas (follow existing patterns)

**FORM PATTERNS:**
- Light theme forms in modals: Use `.input-light`, `.select-light`, `.textarea-light` classes
- Phone inputs: Use `FormPhoneInput` with auto-formatting
- Address inputs: Use `FormAddressInput` with Google Places autocomplete
- State selection: Use `StateSelect` component

### Data Fetching & State

**ALWAYS USE:**
- **TanStack Query** for API calls - Use `useQuery`, `useMutation`, `useQueryClient`
- **Custom hooks** from `hooks/` directory for complex data operations
- **React Context** only for global state (auth, theme, offline sync)

**NEVER USE:**
- Direct `fetch()` in components - Use apiService or TanStack Query
- Redux, MobX, or other state management libraries
- Local state for server data - Use TanStack Query cache

### API & Backend

**ALWAYS USE:**
- **Express.js** with route modules in `backend/routes/`
- **PostgreSQL** with parameterized queries - Never concatenate SQL
- **UUID** for all primary keys - Use `crypto.randomUUID()`
- **Soft deletes** - Use `deleted_at` timestamp, never hard delete

**DATABASE PATTERNS:**
- Snake_case in database (column_name)
- CamelCase in API/JavaScript (columnName)
- Transform with `transformRow()` utility
- Use JSONB for flexible data, normalize for relational data

### Authentication & Security

**ALWAYS USE:**
- **bcryptjs** for password hashing
- **express-session** with PostgreSQL store
- **JWT-like tokens** for API authentication
- **RBAC middleware** from `backend/src/modules/core/auth/rbacMiddleware.js`

**NEVER USE:**
- Plain text passwords
- Hard-coded secrets - Use environment variables
- Direct database access without authentication middleware

### AI & Machine Learning

**ALWAYS USE:**
- **Google Gemini** (@google/genai) for AI features
- **ChromaDB** for vector embeddings and RAG
- **Modular AI services** in `backend/src/modules/ai/`
- **Rate limiting** - 15 requests/minute for AI endpoints

**AI PATTERNS:**
- Use `aiCore` service for chat/assistant features
- Use `estimatorService` for tree estimates
- Store feedback for model improvement
- Use RAG for context-aware responses

### File Structure & Organization

**FRONTEND STRUCTURE:**
```
src/
├── pages/           # Route components
├── components/      # Reusable UI components
├── hooks/          # Custom React hooks
├── services/       # API clients and business logic
├── contexts/       # React Context providers
└── types.ts        # TypeScript type definitions
```

**BACKEND STRUCTURE:**
```
backend/
├── src/modules/    # Domain modules (crm, jobs, ai, etc.)
├── routes/         # API route definitions
├── services/       # Business logic services
├── controllers/    # Request handlers
└── migrations/     # Database schema changes
```

### Testing Rules

**ALWAYS USE:**
- **Vitest** for unit/integration tests
- **Playwright** for E2E tests
- **React Testing Library** for component tests
- **Test files** in `tests/` directory with proper structure

**TESTING PATTERNS:**
- Unit tests: `tests/unit/`
- Integration tests: `tests/integration/`
- E2E tests: `tests/e2e/`
- Smoke tests: `tests/smoke/`

### Performance & Optimization

**ALWAYS USE:**
- **React.memo()** for expensive components
- **useMemo()** and **useCallback()** for expensive computations
- **Code splitting** with `React.lazy()`
- **Image optimization** with appropriate formats

**NEVER USE:**
- Unnecessary re-renders - Profile with React DevTools
- Large bundle sizes - Use dynamic imports
- Synchronous operations - Use async/await properly

### Error Handling

**ALWAYS USE:**
- **Error Boundaries** for React components
- **Try-catch blocks** for async operations
- **Consistent error responses** from API
- **Toast notifications** for user feedback

**ERROR PATTERNS:**
- Frontend: Use `ErrorBoundary` component
- Backend: Use `errorHandler` middleware
- API: Return `{ success: false, error: string }`
- Logging: Use structured logging with context

### Environment Configuration

**ALWAYS USE:**
- **Environment variables** for all secrets
- **.env.example** for documentation
- **Different configs** for development/production
- **Vite env vars** with `VITE_` prefix for frontend

**REQUIRED ENV VARS:**
```
Backend:
- DATABASE_URL
- GEMINI_API_KEY
- GOOGLE_MAPS_API_KEY
- AUTH_TOKEN (optional)

Frontend:
- VITE_GEMINI_API_KEY
- VITE_GOOGLE_MAPS_KEY
```

### Code Quality Rules

**ALWAYS USE:**
- **TypeScript** for type safety
- **ESLint** configuration (if present)
- **Prettier** for code formatting
- **Descriptive variable/function names**

**NEVER USE:**
- `any` type - Use proper TypeScript types
- Magic numbers - Use named constants
- Deeply nested code - Extract functions
- Commented out code - Delete it instead

### Mobile & PWA

**ALWAYS USE:**
- **Responsive design** - Test on mobile viewports
- **Touch-friendly** targets - 44px minimum
- **PWA features** from vite-plugin-pwa
- **Offline support** with IndexedDB persistence

**MOBILE PATTERNS:**
- Use `CrewLayout.tsx` for mobile crew views
- Implement offline sync with `CrewSyncContext`
- Test on actual devices, not just dev tools
- Consider network conditions and battery usage

---

## Quick Reference

### Creating a New Component
```typescript
// Use this pattern
import React from 'react';
import { Button } from '@/components/ui';

interface MyComponentProps {
  title: string;
  onSubmit: () => void;
}

export const MyComponent: React.FC<MyComponentProps> = ({ title, onSubmit }) => {
  return (
    <div className="p-4 bg-white rounded-lg shadow">
      <h2 className="text-lg font-semibold">{title}</h2>
      <Button onClick={onSubmit}>Submit</Button>
    </div>
  );
};
```

### Adding a New API Endpoint
```javascript
// In backend/routes/
router.get('/my-endpoint', async (req, res) => {
  try {
    const result = await myService.getData();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

### Using TanStack Query
```typescript
// In hooks/
export const useMyData = () => {
  return useQuery({
    queryKey: ['myData'],
    queryFn: () => apiService.getMyData(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};
```

---

## Remember

- **Consistency is key** - Follow existing patterns
- **Test everything** - Write tests for new features
- **Think mobile-first** - Design for field crews
- **Security matters** - Never expose sensitive data
- **Performance counts** - Optimize for real-world usage

When in doubt, look at existing code and follow the same patterns. The codebase is your best documentation!