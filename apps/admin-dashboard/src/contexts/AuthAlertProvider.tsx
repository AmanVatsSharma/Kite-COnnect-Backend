import { useMemo, useState, type ReactNode } from 'react';
import { AuthAlertContext } from './auth-alert-context';

export function AuthAlertProvider({ children }: { children: ReactNode }) {
  const [unauthorized, setUnauthorized] = useState(false);
  const value = useMemo(
    () => ({ unauthorized, setUnauthorized }),
    [unauthorized],
  );
  return <AuthAlertContext.Provider value={value}>{children}</AuthAlertContext.Provider>;
}
