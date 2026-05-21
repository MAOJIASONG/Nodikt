/**
 * 文件名称：context.tsx
 * 文件作用：暴露 LanguageProvider + useT() hook，给整站提供 i18n 能力。
 *
 * 设计要点：
 * - 默认语言 "en"，从 localStorage["nodikt:language"] 恢复用户偏好。
 * - useT() 返回 { t, language, setLanguage }；t(key, vars?) 做字典查找 + {var} 插值。
 * - 字典 miss 时 fallback 到 key 本身，避免出空白。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { messages } from "./messages";
import type { Language, MessageDict } from "./messages";

const STORAGE_KEY = "nodikt:language";

function loadInitialLanguage(): Language {
  if (typeof window === "undefined") {
    return "en";
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "en" || raw === "zh") {
    return raw;
  }
  return "en";
}

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

type LanguageContextValue = {
  language: Language;
  setLanguage: (next: Language) => void;
  t: TranslateFn;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? `{${key}}` : String(value);
  });
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(loadInitialLanguage);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, language);
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
  }, []);

  const t = useMemo<TranslateFn>(() => {
    const dict: MessageDict = messages[language] ?? messages.en;
    const fallback: MessageDict = messages.en;
    return (key, vars) => {
      const template = dict[key] ?? fallback[key] ?? key;
      return interpolate(template, vars);
    };
  }, [language]);

  const value = useMemo<LanguageContextValue>(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useT must be used inside <LanguageProvider>");
  }
  return ctx;
}
