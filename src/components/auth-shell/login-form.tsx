// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthErrorMessage, type AuthErrorCode } from "./auth-error-message";
import { authText } from "./messages";
import {
  AuthShellNotImplementedError,
  submitLoginIdentity,
  submitLoginVerification,
} from "./stubs";

// Two-step sign-in shell, following desain-auth.md section 3.1:
// step 1 checks identity (email + password); step 2 verifies the TOTP
// code or a recovery code, only when step 1 returns a challenge.
// The challenge token is kept in component memory only, never in
// storage, matching the V1-08 rule for the real implementation.
//
// SHELL ONLY: both submit handlers call typed stubs that throw, so the
// form always ends in the visible "not connected" error state. Step 2
// is reached in the shell only through the #verify preview hook below
// (see TODO at the hook). The preview hook sets no session and sends
// no request. No registration link is shown: registration stays
// closed per desain-auth.md section 2.4.

type LoginStep = "identity" | "verify";
type VerifyMode = "code" | "recovery";

export function LoginForm() {
  const [step, setStep] = useState<LoginStep>("identity");
  const [verifyMode, setVerifyMode] = useState<VerifyMode>("code");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // TODO(wave-3-auth-wiring): remove this shell-only preview hook.
  // Opening /login#verify shows the step 2 shell for review; the real
  // step 1 response drives the transition once wiring lands.
  useEffect(() => {
    if (window.location.hash === "#verify") {
      setStep("verify");
    }
  }, []);

  function toErrorCode(error: unknown): AuthErrorCode {
    if (error instanceof AuthShellNotImplementedError) return "not_connected";
    return "unexpected";
  }

  async function handleIdentitySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setErrorCode(null);
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
    setIsLoading(true);
    try {
      const result = await submitLoginIdentity({ email: email.trim().toLowerCase(), password });
      if (result.outcome === "totp_required") {
        // Wave 3: keep the challenge token in memory only, as here.
        setChallengeToken(result.challengeToken);
        setStep("verify");
      }
      // TODO(wave-3-auth-wiring): on the "authenticated" outcome,
      // navigate away from the login page and store the CSRF token in
      // memory only. The shell performs no navigation and no session
      // handling.
    } catch (error) {
      setErrorCode(toErrorCode(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setErrorCode(null);
    if (verifyMode === "code") {
      if (!code.trim()) {
        setFieldError(authText("validationCodeRequired"));
        return;
      }
      if (!/^\d{6}$/.test(code.trim())) {
        setFieldError(authText("validationCodeInvalid"));
        return;
      }
    } else if (!recoveryCode.trim()) {
      setFieldError(authText("validationRecoveryCodeRequired"));
      return;
    }
    // The shell has no real challenge token: the preview hook reaches
    // this step without one. The stub throws before any value is used,
    // so no placeholder token is ever sent anywhere.
    if (!challengeToken) {
      setErrorCode("not_connected");
      return;
    }
    setIsLoading(true);
    try {
      const request =
        verifyMode === "code"
          ? { challengeToken, code: code.trim() }
          : { challengeToken, recoveryCode: recoveryCode.trim() };
      await submitLoginVerification(request);
      // TODO(wave-3-auth-wiring): on success, navigate away and store
      // the CSRF token in memory only. The shell performs no
      // navigation.
    } catch (error) {
      setErrorCode(toErrorCode(error));
    } finally {
      setIsLoading(false);
    }
  }

  function handleBackToSignIn() {
    setChallengeToken(null);
    setCode("");
    setRecoveryCode("");
    setFieldError(null);
    setErrorCode(null);
    setStep("identity");
  }

  if (step === "verify") {
    return (
      <form onSubmit={handleVerifySubmit} className="space-y-4" aria-busy={isLoading} noValidate>
        <div className="space-y-2 text-center">
          <h2 className="text-lg font-medium">{authText("verifyTitle")}</h2>
          <p className="text-sm text-muted-foreground">{authText("verifyDescription")}</p>
        </div>
        {verifyMode === "code" ? (
          <div className="space-y-2">
            <Label htmlFor="auth-verification-code">{authText("verificationCodeLabel")}</Label>
            <Input
              id="auth-verification-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={authText("verificationCodePlaceholder")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              disabled={isLoading}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="auth-recovery-code">{authText("recoveryCodeLabel")}</Label>
            <Input
              id="auth-recovery-code"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              placeholder={authText("recoveryCodePlaceholder")}
              autoComplete="off"
              disabled={isLoading}
            />
          </div>
        )}
        {fieldError ? (
          <p className="text-sm text-destructive" role="alert">
            {fieldError}
          </p>
        ) : null}
        {errorCode ? <AuthErrorMessage code={errorCode} /> : null}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? authText("verifyingButton") : authText("verifyButton")}
        </Button>
        <div className="flex flex-col items-center gap-2">
          <Button
            type="button"
            variant="link"
            disabled={isLoading}
            onClick={() => {
              setVerifyMode(verifyMode === "code" ? "recovery" : "code");
              setFieldError(null);
              setErrorCode(null);
            }}
          >
            {verifyMode === "code" ? authText("useRecoveryCode") : authText("useVerificationCode")}
          </Button>
          <Button type="button" variant="link" disabled={isLoading} onClick={handleBackToSignIn}>
            {authText("backToSignIn")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleIdentitySubmit} className="space-y-4" aria-busy={isLoading} noValidate>
      <div className="space-y-2">
        <Label htmlFor="auth-email">{authText("emailLabel")}</Label>
        <Input
          id="auth-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={authText("emailPlaceholder")}
          autoComplete="email"
          disabled={isLoading}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="auth-password">{authText("passwordLabel")}</Label>
        <Input
          id="auth-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={authText("passwordPlaceholder")}
          autoComplete="current-password"
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
        {isLoading ? authText("signingInButton") : authText("signInButton")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">{authText("signInHelp")}</p>
    </form>
  );
}
