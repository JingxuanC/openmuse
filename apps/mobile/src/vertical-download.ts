import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { artifactFileName } from "./vertical-result";

/**
 * Open or save one delegated artifact.
 *
 * The artifact proxy answers only to the session's bearer, so the bytes are
 * fetched here instead of handing a bare URL to the platform: as a blob the
 * browser can save on web, into the share sheet on a device.
 */
export async function downloadArtifact(url: string, token: string, path: string): Promise<void> {
  const authorization = `Bearer ${token}`;
  if (Platform.OS === "web") {
    const response = await fetch(url, { headers: { Authorization: authorization } });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const objectUrl = URL.createObjectURL(await response.blob());
    // A download link needs no popup permission, which a window opened after
    // the awaited fetch no longer has.
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = artifactFileName(path);
    link.click();
    // The browser reads the blob after this returns; only then may it be released.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return;
  }
  const target = `${FileSystem.cacheDirectory}${artifactFileName(path)}`;
  await FileSystem.downloadAsync(url, target, { headers: { Authorization: authorization } });
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("Sharing is not available on this device.");
  await Sharing.shareAsync(target);
}
