import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

type Ctx = {
  unauthorized: boolean;
  setUnauthorized: (v: boolean) => void;
};

const AuthAlertContext = createContext<Ctx | null>(null);

export function AuthAlertProvider({ children }: { children: ReactNode }) {
  const [unauthorized, setUnauthorized] = useState(false);
  const value = useMemo(
    () => ({ unauthorized, setUnauthorized }),
    [unauthorized],
  );
  return <AuthAlertContext.Provider value={value}>{children}</AuthAlertContext.Provider>;
}

export function useAuthAlert() {
  const c = useContext(AuthAlertContext);
  if (!c) throw new Error('useAuthAlert outside provider');
  return c;
}
