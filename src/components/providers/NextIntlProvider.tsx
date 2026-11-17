'use client';

import { NextIntlClientProvider } from 'next-intl';
import type { AbstractIntlMessages } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LOCALE,
  I18N_LOAD_TIMEOUT_MS,
  PLUGIN_LANGUAGES_CHANGED,
  LANGUAGE_STORAGE_KEY,
  loadMessagesWithFallback,
  normalizeLocale,
  type SupportedLocale,
} from '@/i18n/config';

// Stable machine codes for the catalog failure screen. The screen
// renders hardcoded English strings (the boot guard precedent in
// src/lib/web/boot-guard.ts): the catalog itself is unavailable, so
// no message key can be trusted to render the failure.
type I18nFailureCode = 'BOOT_I18N_TIMEOUT' | 'BOOT_I18N_FAILED';

export function NextIntlProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<AbstractIntlMessages | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>(DEFAULT_LOCALE);
  const [failure, setFailure] = useState<I18nFailureCode | null>(null);
  const [attempt, setAttempt] = useState(0);
  // True once any catalog has loaded. A failed refresh after the
  // first load keeps the loaded messages on screen; only a failure
  // before the first load shows the error screen.
  const loadedRef = useRef(false);

  useEffect(() => {
    let request = 0
    const refresh = () => {
      const current = ++request
      const savedLocale = normalizeLocale(localStorage.getItem(LANGUAGE_STORAGE_KEY))
      const loadPromise = loadMessagesWithFallback(savedLocale)
      // Mark the load handled up front: when the timeout wins the
      // race below, a later rejection of this promise must not
      // surface as an unhandled rejection.
      void loadPromise.catch(() => {})
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('I18N_LOAD_TIMEOUT'))
        }, I18N_LOAD_TIMEOUT_MS)
      })
      void Promise.race([loadPromise, timeoutPromise]).then(loaded => {
        if (current !== request) return
        clearTimeout(timer)
        loadedRef.current = true
        setLocale(savedLocale)
        setMessages(loaded)
        setFailure(null)
      }).catch(error => {
        if (current !== request) return
        clearTimeout(timer)
        const timedOut = error instanceof Error && error.message === 'I18N_LOAD_TIMEOUT'
        console.error('Failed to load language', error)
        // A refresh failure after a successful load never blanks
        // the app: the loaded catalog stays on screen.
        if (loadedRef.current) return
        setFailure(timedOut ? 'BOOT_I18N_TIMEOUT' : 'BOOT_I18N_FAILED')
      })
    }
    refresh()
    window.addEventListener(PLUGIN_LANGUAGES_CHANGED, refresh)
    window.addEventListener('storage', refresh)
    return () => { request++; window.removeEventListener(PLUGIN_LANGUAGES_CHANGED, refresh); window.removeEventListener('storage', refresh) }
  }, [attempt]);

  if (messages) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    );
  }

  if (failure) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div
          role="alert"
          className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm"
        >
          <h1 className="text-lg font-semibold">Could not load the language.</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">NoteGen could not load its language files. Your notes are safe. Try again.</p>
          <p className="mt-4 font-mono text-xs text-muted-foreground">Code: {failure}</p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => { setFailure(null); setAttempt((n) => n + 1) }}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Visible loading state while the first catalog loads. Upstream
  // this gate rendered null, so a slow catalog load looked exactly
  // like a hung page. The status below makes a slow load observable
  // and bounds it: the timeout above replaces it with the error
  // screen when the catalog never settles.
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 text-center">
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
        />
        <p className="text-sm text-muted-foreground">Loading language...</p>
      </div>
    </main>
  );
}
