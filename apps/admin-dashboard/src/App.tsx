import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthAlertProvider } from './contexts/AuthAlertProvider';
import { QueryProvider } from './providers/QueryProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { ProviderPage } from './pages/ProviderPage';
import { WsAdminPage } from './pages/WsAdminPage';
import { AbusePage } from './pages/AbusePage';
import { AuditDebugPage } from './pages/AuditDebugPage';
import { AuthPage } from './pages/AuthPage';
import { ConsolePage } from './pages/ConsolePage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return (
    <ErrorBoundary>
      <AuthAlertProvider>
        <QueryProvider>
          <BrowserRouter basename="/dashboard">
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<OverviewPage />} />
                <Route path="keys" element={<ApiKeysPage />} />
                <Route path="provider" element={<ProviderPage />} />
                <Route path="ws" element={<WsAdminPage />} />
                <Route path="abuse" element={<AbusePage />} />
                <Route path="audit" element={<AuditDebugPage />} />
                <Route path="auth" element={<AuthPage />} />
                <Route path="console" element={<ConsolePage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </QueryProvider>
      </AuthAlertProvider>
    </ErrorBoundary>
  );
}
