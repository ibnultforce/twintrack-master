import type { Scope } from './api/types';

export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return `${words[0]?.[0] ?? ''}${words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''}`.toUpperCase();
}

export function humanize(key?: string | null): string {
  if (!key) return '·';
  const text = key.replace(/[-_.]/g, ' ');
  return `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

export const peopleCount = (count: number) => (count === 1 ? '1 person' : `${count} people`);

export function formatTime(at: string): string {
  const date = new Date(at);
  return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export const longDate = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export const SCOPE_LABELS: Record<Scope, string> = { own: 'Their own', team: 'Their team', all: 'Everyone' };

export const SCOPE_LEGEND = 'Their own means only that person. Their team adds their direct reports. Everyone means all people.';
