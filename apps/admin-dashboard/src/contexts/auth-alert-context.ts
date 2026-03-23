import { createContext } from 'react';

export type AuthAlertCtx = {
  unauthorized: boolean;
  setUnauthorized: (v: boolean) => void;
};

export const AuthAlertContext = createContext<AuthAlertCtx | null>(null);
