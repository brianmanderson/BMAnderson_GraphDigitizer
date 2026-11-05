/**
 * Light/dark theme: `data-theme` on <html>, chosen by the viewer. With no saved choice the OS
 * preference (`prefers-color-scheme`) decides. The choice is a per-browser convenience in
 * localStorage, not part of the Project or the autosave. index.html applies the same rule
 * before first paint (keep its key in sync with THEME_KEY).
 */

export type Theme = 'light' | 'dark';

export const THEME_KEY = 'graph-digitizer:theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The saved choice, or null when there is none or storage is unavailable. */
export function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private window or blocked storage: the choice lasts for this page only.
  }
}

export const systemTheme = (): Theme => (window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light');

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Follow OS theme changes while the viewer has not chosen one; returns the unsubscribe. */
export function followSystemTheme(onChange: (theme: Theme) => void): () => void {
  const mq = window.matchMedia?.(DARK_QUERY);
  if (!mq) return () => {};
  const listener = () => {
    if (savedTheme() === null) onChange(mq.matches ? 'dark' : 'light');
  };
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}
