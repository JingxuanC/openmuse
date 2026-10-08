/**
 * The artifact rendered from its blob URL.
 *
 * The iframe is sandboxed without `allow-same-origin`: a report may carry its
 * own chart scripts (which run), but it can never reach the app's origin,
 * storage or cookies, whatever the delegate wrote into it.
 */
export default function ArtifactFrame({
  objectUrl,
  kind,
  title,
}: {
  objectUrl: string;
  kind: string;
  title: string;
}) {
  if (kind === "image")
    return (
      <img
        alt={title}
        src={objectUrl}
        style={{ maxWidth: "100%", borderRadius: 12, display: "block", margin: "0 auto" }}
      />
    );
  return (
    <iframe
      title={title}
      src={objectUrl}
      sandbox="allow-scripts"
      style={{ height: 640, width: "100%", border: 0, borderRadius: 12, background: "#fff" }}
    />
  );
}
