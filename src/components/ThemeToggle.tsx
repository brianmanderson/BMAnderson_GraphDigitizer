import { useEffect, useState } from 'react';
import { applyTheme, currentTheme, followSystemTheme, saveTheme, type Theme } from '../ui/theme.ts';

/** Toolbar toggle between the light and dark theme; an explicit choice is remembered. */
export function ThemeToggle() {
  // index.html has already applied the saved or OS theme before first paint.
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => followSystemTheme(setTheme), []);

  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="toggle icon-text"
      aria-pressed={dark}
      aria-label="Dark theme"
      title={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      onClick={() => {
        const next: Theme = dark ? 'light' : 'dark';
        saveTheme(next);
        setTheme(next);
      }}
    >
      {dark ? '☾' : '☀'}
    </button>
  );
}
