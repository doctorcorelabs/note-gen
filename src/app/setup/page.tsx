// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
import { AuthShell } from "@/components/auth-shell/auth-shell";
import { SetupForm } from "@/components/auth-shell/setup-form";

// First-account setup page shell (UI only). Check-first result:
// upstream has no setup route, so this page is new. It holds no
// session, cookie, or CSRF logic; wave 3 auth wiring owns the call
// behind SetupForm. The root layout is untouched by this task.
export default function SetupPage() {
  return (
    <AuthShell titleKey="setupTitle" descriptionKey="setupDescription">
      <SetupForm />
    </AuthShell>
  );
}
