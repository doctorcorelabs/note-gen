// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthErrorMessage, type AuthErrorCode } from "./auth-error-message";
import { authText } from "./messages";
import { AuthShellNotImplementedError, submitSetup } from "./stubs";

// First-account setup shell, following desain-auth.md section 2.2:
// the operator supplies the setup token plus the new admin account
// details. Setup creates no session: after success the operator signs
// in through the normal login flow, which is why the success state
// only links to /login.
//
// SHELL ONLY: submit calls a typed stub that throws, so the form always
// ends in the visible "not connected" error state.
// TODO(wave-3-auth-wiring): replace the stub call in handleSubmit with
// the real POST /api/auth/setup call. Client-side checks below mirror
// the contract limits (password 12-128 characters); the server remains
// the authority and re-validates everything.

export function SetupForm() {
  const [setupToken, setSetupToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreated, setIsCreated] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setErrorCode(null);
    if (!setupToken.trim()) {
      setFieldError(authText("validationSetupTokenRequired"));
      return;
    }
    if (!email.trim()) {
      setFieldError(authText("validationEmailRequired"));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFieldError(authText("validationEmailInvalid"));
      return;
    }
    if (!password) {
      setFieldError(authText("validationPasswordRequired"));
      return;
    }
    if (password.length < 12) {
      setFieldError(authText("validationPasswordTooShort"));
      return;
    }
    if (password.length > 128) {
      setFieldError(authText("validationPasswordTooLong"));
      return;
    }
    if (password !== confirmPassword) {
      setFieldError(authText("validationPasswordsDoNotMatch"));
      return;
    }
    setIsLoading(true);
    try {
      await submitSetup({
        setupToken: setupToken.trim(),
        email: email.trim().toLowerCase(),
        password,
        workspaceName: workspaceName.trim() || undefined,
      });
      // TODO(wave-3-auth-wiring): this success state is driven by the
      // real 201 response once submitSetup is wired; setup creates no
      // session, so the state only links to /login.
      setIsCreated(true);
    } catch (error) {
      if (error instanceof AuthShellNotImplementedError) {
        setErrorCode("not_connected");
      } else {
        setErrorCode("unexpected");
      }
    } finally {
      setIsLoading(false);
    }
  }

  if (isCreated) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="text-lg font-medium">{authText("setupSuccessTitle")}</h2>
        <p className="text-sm text-muted-foreground">{authText("setupSuccessDescription")}</p>
        <Button asChild className="w-full">
          <Link href="/login">{authText("goToSignInButton")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-busy={isLoading} noValidate>
      <div className="space-y-2">
        <Label htmlFor="auth-setup-token">{authText("setupTokenLabel")}</Label>
        <Input
          id="auth-setup-token"
          type="password"
          value={setupToken}
          onChange={(event) => setSetupToken(event.target.value)}
          placeholder={authText("setupTokenPlaceholder")}
          autoComplete="off"
          disabled={isLoading}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="auth-setup-email">{authText("emailLabel")}</Label>
        <Input
          id="auth-setup-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={authText("emailPlaceholder")}
          autoComplete="email"
          disabled={isLoading}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="auth-setup-password">{authText("passwordLabel")}</Label>
        <Input
          id="auth-setup-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={authText("passwordPlaceholder")}
          autoComplete="new-password"
          disabled={isLoading}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="auth-setup-confirm-password">{authText("confirmPasswordLabel")}</Label>
        <Input
          id="auth-setup-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder={authText("confirmPasswordPlaceholder")}
          autoComplete="new-password"
          disabled={isLoading}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="auth-setup-workspace">{authText("workspaceNameLabel")}</Label>
        <Input
          id="auth-setup-workspace"
          value={workspaceName}
          onChange={(event) => setWorkspaceName(event.target.value)}
          placeholder={authText("workspaceNamePlaceholder")}
          autoComplete="off"
          disabled={isLoading}
        />
      </div>
      {fieldError ? (
        <p className="text-sm text-destructive" role="alert">
          {fieldError}
        </p>
      ) : null}
      {errorCode ? <AuthErrorMessage code={errorCode} /> : null}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? authText("creatingAccountButton") : authText("createAccountButton")}
      </Button>
    </form>
  );
}
