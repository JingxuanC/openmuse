import "react-native-url-polyfill/auto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { API_URL } from "./api";
import { sessionStorage } from "./session-store";
import { supabaseFetch } from "./supabase-proxy";

/** The shared OpenMuse project; the server verifies tokens from the same one. */
export const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "") ||
  "https://veysvzfcyjxxbhvcfhuv.supabase.co";

/** Expo inlines EXPO_PUBLIC_* at build time, so this is a build-time value, not a secret. */
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() || "";

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  if (!SUPABASE_ANON_KEY)
    throw new Error(
      "EXPO_PUBLIC_SUPABASE_ANON_KEY is not set. Copy apps/mobile/.env.example to apps/mobile/.env and add the project's anon key.",
    );
  // Supabase refreshes the token on this client; the server only verifies it.
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // Auth goes through our own API, so a browser that cannot reach supabase.co still signs in.
    global: { fetch: supabaseFetch(SUPABASE_URL, API_URL) },
    auth: {
      storage: sessionStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
