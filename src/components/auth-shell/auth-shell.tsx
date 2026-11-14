// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { authText, type AuthMessageKey } from "./messages";

export interface AuthShellProps {
  titleKey: AuthMessageKey;
  descriptionKey: AuthMessageKey;
  children: ReactNode;
}

// Centered single-column layout shared by the login and setup pages.
// The shell notice is part of the shell, not of the product: it states
// plainly that sign-in is not connected yet, so the pages make no
// security claim the code behind them does not support. Wave 3 wiring
// removes the notice when the real auth calls land.
export function AuthShell({ titleKey, descriptionKey, children }: AuthShellProps) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{authText(titleKey)}</h1>
          <p className="text-sm text-muted-foreground">{authText(descriptionKey)}</p>
        </div>
        <Alert>
          <AlertDescription>{authText("shellNotice")}</AlertDescription>
        </Alert>
        <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">{children}</div>
      </div>
    </main>
  );
}
