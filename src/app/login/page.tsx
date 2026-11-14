// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
import { AuthShell } from "@/components/auth-shell/auth-shell";
import { LoginForm } from "@/components/auth-shell/login-form";
import { SessionExpiredBanner } from "@/components/auth-shell/session-expired-notice";

// Login page shell (UI only). Check-first result: upstream has no
// login route, so this page is new. It holds no session, cookie, or
// CSRF logic; wave 3 auth wiring owns the calls behind LoginForm.
// The root layout is untouched by this task (V2-08 owns page.tsx and
// layout changes are out of scope), so this page renders inside the
// existing layout exactly like every other route.
export default function LoginPage() {
  return (
    <AuthShell titleKey="loginTitle" descriptionKey="loginDescription">
      <SessionExpiredBanner />
      <LoginForm />
    </AuthShell>
  );
}
