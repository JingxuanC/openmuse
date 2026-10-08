import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { API_URL } from "./api";
import { supabase } from "./supabase";

export type AuthMode = "supabase" | "local";

/**
 * Supabase is the default, matching the server. `local` keeps the single-owner
 * access key so a development server without Supabase still opens.
 */
export const authMode: AuthMode =
  process.env.EXPO_PUBLIC_AUTH_MODE === "local" ? "local" : "supabase";

export interface ClientSession {
  token: string;
  mode: "sample" | "live";
}

interface ServerSession {
  mode: "sample" | "live";
  token?: string;
}

async function openWorkspace(body: {
  accessKey?: string;
  accessToken?: string;
}): Promise<ServerSession> {
  const response = await fetch(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not open your workspace.");
  return payload;
}

/** The server verifies the token and prepares the tenant; Supabase keeps minting it. */
async function openWithToken(accessToken: string): Promise<ClientSession> {
  const session = await openWorkspace({ accessToken });
  return { token: accessToken, mode: session.mode };
}

export async function openLocalSession(accessKey?: string): Promise<ClientSession> {
  const session = await openWorkspace({ accessKey });
  return { token: session.token ?? "", mode: session.mode };
}

export async function signInWithPassword(email: string, password: string): Promise<ClientSession> {
  const { data, error } = await supabase().auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw new Error(error.message);
  if (!data.session) throw new Error("Supabase returned no session. Try again.");
  return openWithToken(data.session.access_token);
}

export async function signUpWithPassword(email: string, password: string): Promise<ClientSession> {
  const { data, error } = await supabase().auth.signUp({ email: email.trim(), password });
  if (error) throw new Error(error.message);
  // A project with email confirmation on returns a user but no session yet.
  if (!data.session) throw new Error("Confirm the address from your inbox, then sign in.");
  return openWithToken(data.session.access_token);
}

/** Requires the project's mail template to include the {{ .Token }} placeholder. */
export async function sendEmailCode(email: string): Promise<void> {
  const { error } = await supabase().auth.signInWithOtp({ email: email.trim() });
  if (error) throw new Error(error.message);
}

export async function verifyEmailCode(email: string, code: string): Promise<ClientSession> {
  const { data, error } = await supabase().auth.verifyOtp({
    email: email.trim(),
    token: code.trim(),
    type: "email",
  });
  if (error) throw new Error(error.message);
  if (!data.session) throw new Error("That code opened no session. Request a new one.");
  return openWithToken(data.session.access_token);
}

const expiresSoon = (session: Session) => (session.expires_at ?? 0) * 1000 < Date.now() + 60_000;

/** The refresh token never leaves the device; the server only ever sees access tokens. */
export async function renewAccessToken(): Promise<string | undefined> {
  const { data, error } = await supabase().auth.refreshSession();
  return error ? undefined : data.session?.access_token;
}

export async function restoreSession(): Promise<ClientSession | undefined> {
  const { data } = await supabase().auth.getSession();
  const session = data.session;
  if (!session) return undefined;
  const accessToken = expiresSoon(session) ? await renewAccessToken() : session.access_token;
  return accessToken ? openWithToken(accessToken) : undefined;
}

export type AuthStatus = "loading" | "signedOut" | "ready";

export interface Auth {
  status: AuthStatus;
  token: string;
  error: string;
  busy: boolean;
  /** Runs one sign-in step and opens the workspace when it returns a session. */
  submit(action: () => Promise<ClientSession>): Promise<void>;
  /** Silent renewal, for coming back to the foreground and for a 401. */
  renew(): Promise<string | undefined>;
  /** The token is gone for good; fall back to the sign-in screen. */
  expire(): void;
}

export function useAuth(): Auth {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const open = useCallback((session: ClientSession) => {
    setToken(session.token);
    setError("");
    setStatus("ready");
  }, []);

  const fail = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
    setStatus("signedOut");
  }, []);

  const expire = useCallback(() => {
    setToken("");
    setError("Your session expired. Sign in again.");
    setStatus("signedOut");
  }, []);

  const submit = useCallback(
    async (action: () => Promise<ClientSession>) => {
      setBusy(true);
      setError("");
      try {
        open(await action());
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [fail, open],
  );

  const renew = useCallback(async () => {
    if (authMode === "local") return undefined;
    try {
      const renewed = await renewAccessToken();
      if (renewed) setToken(renewed);
      return renewed;
    } catch {
      // A renewal that cannot reach Supabase leaves the current token in place.
      return undefined;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (authMode === "local") {
          const session = await openLocalSession();
          if (active) open(session);
          return;
        }
        const session = await restoreSession();
        if (!active) return;
        if (session) open(session);
        else setStatus("signedOut");
      } catch (cause) {
        if (active) fail(cause);
      }
    })();
    return () => {
      active = false;
    };
  }, [fail, open]);

  useEffect(() => {
    if (authMode !== "supabase") return;
    // A backgrounded client stops refreshing, so catch up on the way back in.
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void renew();
    });
    return () => listener.remove();
  }, [renew]);

  return { status, token, error, busy, submit, renew, expire };
}
