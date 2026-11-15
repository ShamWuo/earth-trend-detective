"use client";

import React, { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "color-scheme";

function getSystemScheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredOverride(): "light" | "dark" | null {
  try {
    const val = window.localStorage.getItem(STORAGE_KEY);
    return val === "light" || val === "dark" ? val : null;
  } catch {
    return null;
  }
}

function disableTransitionsForThemeSwap(apply: () => void) {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.appendChild(style);
  try {
    apply();
    // Commit computed theme colors synchronously before re-enabling hover transitions.
    void window.getComputedStyle(document.documentElement).color;
    void window.getComputedStyle(document.body).backgroundColor;
  } finally {
    window.setTimeout(() => {
      style.remove();
    }, 0);
  }
}

function applySchemeToDocument(override: "light" | "dark" | null) {
  const resolved = override ?? getSystemScheme();
  disableTransitionsForThemeSwap(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (meta) {
      meta.content = override ?? "light dark";
    }
    document.documentElement.classList.toggle("light", resolved === "light");
    document.documentElement.setAttribute("data-theme-ready", "true");
  });
  return resolved;
}

export function ThemeToggle() {
  const [resolvedScheme, setResolvedScheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    setResolvedScheme(applySchemeToDocument(getStoredOverride()));

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      // Never retroactively delete a stored override when OS changes to match it.
      setResolvedScheme(applySchemeToDocument(getStoredOverride()));
    };
    const onStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setResolvedScheme(applySchemeToDocument(getStoredOverride()));
      }
    };

    mql.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorageChange);
    return () => {
      mql.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorageChange);
    };
  }, []);

  const handleToggle = () => {
    const currentRendered = getStoredOverride() ?? getSystemScheme();
    const target = currentRendered === "dark" ? "light" : "dark";
    const system = getSystemScheme();

    try {
      if (target === system) {
        // Reverting to OS preference: remove stored override rather than pinning it
        window.localStorage.removeItem(STORAGE_KEY);
        setResolvedScheme(applySchemeToDocument(null));
      } else {
        window.localStorage.setItem(STORAGE_KEY, target);
        setResolvedScheme(applySchemeToDocument(target));
      }
    } catch {
      setResolvedScheme(applySchemeToDocument(target));
    }
  };

  const nextLabel = resolvedScheme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={handleToggle}
      aria-label={nextLabel}
      title={nextLabel}
      className="etg-hud-btn inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-elevated text-text-muted transition-colors hover:border-border-strong hover:text-text-primary cursor-pointer"
    >
      {resolvedScheme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </button>
  );
}
