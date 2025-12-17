import React from 'react';
import { recordError } from '../utils/telemetry';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    recordError(error, 'React error boundary', { componentStack: info.componentStack });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: undefined });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
          <div className="max-w-xl w-full bg-white shadow-lg rounded-2xl p-8 border border-slate-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center font-semibold">
                !
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-900">
                  {this.props.fallbackTitle ?? 'Something went wrong'}
                </h1>
                <p className="text-sm text-slate-500">
                  {this.props.fallbackMessage ?? 'An unexpected error occurred. The team has been notified.'}
                </p>
              </div>
            </div>

            {this.state.error?.message && (
              <pre className="bg-slate-50 text-xs text-slate-600 p-3 rounded-md border border-slate-100 overflow-auto mb-4">
                {this.state.error.message}
              </pre>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-brand-cyan-500 text-white font-medium shadow-sm hover:bg-brand-cyan-600 transition"
              >
                Reload and continue
              </button>
              <p className="text-xs text-slate-500">
                If this keeps happening, please share the steps you took leading up to this screen.
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;