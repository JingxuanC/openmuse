/**
 * The web preview has localStorage and no SecureStore, and no 2048-byte cap to
 * work around, so the value is kept whole.
 */
export const sessionStorage = {
  async getItem(key: string) {
    return globalThis.localStorage?.getItem(key) ?? null;
  },
  async setItem(key: string, value: string) {
    globalThis.localStorage?.setItem(key, value);
  },
  async removeItem(key: string) {
    globalThis.localStorage?.removeItem(key);
  },
};
