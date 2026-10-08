import { Platform } from "react-native";

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");

export interface MuseApiOptions {
  /** Renews the access token; a 401 retries once with whatever this returns. */
  renew?: () => Promise<string | undefined>;
  /** Called when a 401 cannot be recovered, so the app can return to sign-in. */
  onExpired?: () => void;
}

export class MuseApi {
  constructor(
    public token: string,
    private readonly options: MuseApiOptions = {},
  ) {}
  private send(path: string, body: unknown, method: string | undefined, token: string) {
    return fetch(`${API_URL}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  }
  private async parse<T>(response: Response): Promise<T> {
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
      );
    return payload;
  }
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await this.send(path, body, method, this.token);
    if (response.status !== 401 || !this.options.renew) return this.parse<T>(response);
    // The access token expires hourly; renew once before giving up on the session.
    const renewed = await this.options.renew();
    if (!renewed) {
      this.options.onExpired?.();
      throw new Error("Your session expired. Sign in again.");
    }
    this.token = renewed;
    return this.parse<T>(await this.send(path, body, method, renewed));
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
}
