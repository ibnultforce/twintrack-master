import type { BadgeTone } from '@/components/ui/Badge';
import { humanizeKey } from '@/lib/format';

interface ActivityLabel {
  label: string;
  tone: BadgeTone;
}

const ACTIVITY_LABELS: Record<string, ActivityLabel> = {
  'auth.login': { label: 'Signed in', tone: 'neutral' },
  'auth.login_failed': { label: 'Sign-in failed', tone: 'danger' },
  'auth.logout': { label: 'Signed out', tone: 'neutral' },
  'auth.password_changed': { label: 'Password changed', tone: 'warning' },
  'auth.session_token_reused': { label: 'Stolen token blocked', tone: 'danger' },
  'user.created': { label: 'Person added', tone: 'good' },
  'user.updated': { label: 'Details edited', tone: 'warning' },
  'user.name_changed': { label: 'Name changed', tone: 'warning' },
  'user.deactivated': { label: 'Deactivated', tone: 'danger' },
  'user.reactivated': { label: 'Reactivated', tone: 'good' },
  'user.password_reset': { label: 'Password reset', tone: 'warning' },
  'user.role_changed': { label: 'Role changed', tone: 'accent' },
  'user.privileges_changed': { label: 'Privileges changed', tone: 'accent' },
  'module.imported': { label: 'Module imported', tone: 'good' },
  'module.removed': { label: 'Module removed', tone: 'danger' },
};

/** Actions added later still read sensibly, using the part of the code after the dot. */
export function activityLabel(action: string): ActivityLabel {
  return ACTIVITY_LABELS[action] ?? { label: humanizeKey(action.split('.').pop()), tone: 'neutral' };
}
