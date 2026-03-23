import { useContext } from 'react';
import { AuthAlertContext } from '../contexts/auth-alert-context';

export function useAuthAlert() {
  const c = useContext(AuthAlertContext);
  if (!c) throw new Error('useAuthAlert outside AuthAlertProvider');
  return c;
}
