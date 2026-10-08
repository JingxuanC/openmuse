import * as SecureStore from "expo-secure-store";

/**
 * SecureStore refuses values above 2048 bytes, and a Supabase session is a JWT
 * plus a user record that regularly exceeds that. The value is split across
 * numbered sibling keys, and the chunk count is kept under the original key.
 */
const CHUNK_BYTES = 1800;

function split(value: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  chunks.push(chunk);
  return chunks;
}

export const sessionStorage = {
  async getItem(key: string) {
    const meta = await SecureStore.getItemAsync(key);
    if (meta === null) return null;
    const count = Number(meta);
    // Anything that is not our own chunk count was written as a single value.
    if (!Number.isInteger(count) || count < 1) return meta;
    const parts = await Promise.all(
      Array.from({ length: count }, (_, index) => SecureStore.getItemAsync(`${key}.${index}`)),
    );
    return parts.includes(null) ? null : parts.join("");
  },
  async setItem(key: string, value: string) {
    const previous = Number(await SecureStore.getItemAsync(key));
    const chunks = split(value);
    for (let index = 0; index < chunks.length; index++)
      await SecureStore.setItemAsync(`${key}.${index}`, chunks[index]);
    // The count is written last so a reader never sees a count without its chunks.
    await SecureStore.setItemAsync(key, String(chunks.length));
    if (Number.isInteger(previous) && previous > chunks.length)
      await Promise.all(
        Array.from({ length: previous - chunks.length }, (_, offset) =>
          SecureStore.deleteItemAsync(`${key}.${chunks.length + offset}`),
        ),
      );
  },
  async removeItem(key: string) {
    const count = Number(await SecureStore.getItemAsync(key));
    await SecureStore.deleteItemAsync(key);
    if (!Number.isInteger(count) || count < 1) return;
    await Promise.all(
      Array.from({ length: count }, (_, index) => SecureStore.deleteItemAsync(`${key}.${index}`)),
    );
  },
};
