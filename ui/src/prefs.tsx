import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyDensity,
  applyTheme,
  loadDensity,
  loadLocale,
  loadTheme,
  saveDensity,
  saveLocale,
  saveTheme,
  translate,
  type Density,
  type Locale,
  type MsgKey,
  type Theme,
} from "./i18n";

type PrefsCtx = {
  locale: Locale;
  theme: Theme;
  density: Density;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  t: (key: MsgKey, ...args: string[]) => string;
};

const Ctx = createContext<PrefsCtx | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => loadLocale());
  const [theme, setThemeState] = useState<Theme>(() => {
    const t = loadTheme();
    applyTheme(t);
    return t;
  });
  const [density, setDensityState] = useState<Density>(() => {
    const d = loadDensity();
    applyDensity(d);
    return d;
  });

  const setLocale = useCallback((next: Locale) => {
    saveLocale(next);
    setLocaleState(next);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    saveTheme(next);
    applyTheme(next);
    setThemeState(next);
  }, []);

  const setDensity = useCallback((next: Density) => {
    saveDensity(next);
    applyDensity(next);
    setDensityState(next);
  }, []);

  const t = useCallback(
    (key: MsgKey, ...args: string[]) => translate(locale, key, ...args),
    [locale],
  );

  const value = useMemo(
    () => ({ locale, theme, density, setLocale, setTheme, setDensity, t }),
    [locale, theme, density, setLocale, setTheme, setDensity, t],
  );

  return createElement(Ctx.Provider, { value }, children);
}

export function usePrefs() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePrefs must be used within PrefsProvider");
  return ctx;
}
