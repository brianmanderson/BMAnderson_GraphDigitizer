import { useEffect, useState } from 'react';
import { applyTheme, currentTheme, followSystemTheme, saveTheme, type Theme } from '../ui/theme.ts';

/**
 * Toolbar toggle between the light and dark theme; an explicit choice is remembered. Its name is
 * the theme a click switches to ("Dark theme" while light, "Light theme" while dark), the owner's
 * choice over a fixed name with `aria-pressed`.
 */
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
      aria-label={dark ? 'Light theme' : 'Dark theme'}
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
