/**
 * @file App.tsx
 * @module admin-dashboard
 * @description Root routes, query client, and terminal shell layout.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-04-14
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthAlertProvider } from './contexts/AuthAlertProvider';
import { RefreshIntervalProvider } from './contexts/RefreshIntervalProvider';
import { QueryProvider } from './providers/QueryProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TerminalLayout } from './components/TerminalLayout';
import { OverviewPage } from './pages/OverviewPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { ProviderPage } from './pages/ProviderPage';
import { WsAdminPage } from './pages/WsAdminPage';
import { AbusePage } from './pages/AbusePage';
import { AuditDebugPage } from './pages/AuditDebugPage';
import { AuthPage } from './pages/AuthPage';
import { ConsolePage } from './pages/ConsolePage';
import { SettingsPage } from './pages/SettingsPage';
import { FalconPage } from './pages/FalconPage';

export default function App() {
  return (
    <ErrorBoundary>
      <AuthAlertProvider>
        <QueryProvider>
          <RefreshIntervalProvider>
            <BrowserRouter basename="/dashboard">
              <Routes>
                <Route path="/" element={<TerminalLayout />}>
                  <Route index element={<OverviewPage />} />
                  <Route path="workspace" element={<WorkspacePage />} />
                  <Route path="keys" element={<ApiKeysPage />} />
                  <Route path="provider" element={<ProviderPage />} />
                  <Route path="ws" element={<WsAdminPage />} />
                  <Route path="abuse" element={<AbusePage />} />
                  <Route path="audit" element={<AuditDebugPage />} />
                  <Route path="falcon" element={<FalconPage />} />
                  <Route path="auth" element={<AuthPage />} />
                  <Route path="console" element={<ConsolePage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </RefreshIntervalProvider>
        </QueryProvider>
      </AuthAlertProvider>
    </ErrorBoundary>
  );
}
