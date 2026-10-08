import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { LocalIntelligence } from "./local-intelligence.ts";

/** The runtime's Phoenix client and runner derive their socket URLs from this base. */
export function realtimeBaseFromPublicUrl(publicUrl: string): string {
  return `${publicUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/intelligence/realtime`;
}

/**
 * Thread persistence defaults to the local Postgres/PGlite store. The
 * CopilotKit Intelligence cloud is used only when explicitly opted into with
 * `INTELLIGENCE_BACKEND=copilotkit` plus a project key.
 */
export function createIntelligence(db: Store, config: Config): CopilotKitIntelligence {
  if (config.intelligenceBackend === "copilotkit") {
    if (!config.intelligenceApiKey)
      throw new Error("INTELLIGENCE_BACKEND=copilotkit requires CPK_INTELLIGENCE_API_KEY");
    return new CopilotKitIntelligence({ apiKey: config.intelligenceApiKey });
  }
  return new LocalIntelligence(db, { wsBaseUrl: realtimeBaseFromPublicUrl(config.publicUrl) });
}
