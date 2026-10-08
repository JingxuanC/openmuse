/**
 * Which artifacts can be shown right in the conversation instead of saved.
 *
 * A report is meant to be read, not filed: the proxy already serves its bytes
 * under the session token, so the card can fetch them into a blob URL and
 * render that inline. Everything not listed here keeps the download path —
 * a CSV or a spreadsheet has no useful inline rendering.
 */
export type PreviewKind = "html" | "image";

const kinds: Record<string, PreviewKind> = {
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
};

export function previewKind(path: string): PreviewKind | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  return kinds[path.slice(dot + 1).toLowerCase()];
}
