import { Download, ExternalLink, FileText, Link2 } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from "react-native";
import ArtifactFrame from "./ArtifactFrame";
import { isSafeAssistantUrl } from "./assistant-markdown";
import { AssistantResponse } from "./assistant-response";
import { Button, Card, colors, ErrorNotice, Sheet, s } from "./ui";
import { downloadArtifact } from "./vertical-download";
import { type PreviewKind, previewKind } from "./vertical-preview";
import { type VerticalResult, verticalFilePath } from "./vertical-result";
import { useWorkspace } from "./workspace";

interface Preview {
  objectUrl: string;
  kind: PreviewKind;
  title: string;
  path: string;
}

/**
 * What a delegate produced, shown in the conversation it answered.
 *
 * The report is the delegate's own words; the files below it are what the
 * report was built from, served through OpenMuse so the session token stays on
 * the server.
 */
export function VerticalArtifactCard({ name, result }: { name: string; result: VerticalResult }) {
  const { api } = useWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [linkError, setLinkError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const summary = [
    result.artifacts.length
      ? `${result.artifacts.length} artifact${result.artifacts.length === 1 ? "" : "s"}`
      : "",
    result.sources.length
      ? `${result.sources.length} source${result.sources.length === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  async function open(path: string) {
    setBusy(path);
    setError("");
    try {
      await downloadArtifact(api.url(verticalFilePath(name, path)), api.token, path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  /**
   * Inline reading for what a person reads: the bytes are fetched under the
   * session token exactly like a download, then rendered from a blob URL —
   * which also dodges the popup blocker an awaited `window.open` would hit.
   */
  async function show(path: string, title: string, kind: PreviewKind) {
    setBusy(path);
    setError("");
    try {
      const response = await fetch(api.url(verticalFilePath(name, path)), {
        headers: { Authorization: `Bearer ${api.token}` },
      });
      if (!response.ok) throw new Error(`Preview failed (${response.status})`);
      const objectUrl = URL.createObjectURL(await response.blob());
      setPreview({ objectUrl, kind, title, path });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function closePreview() {
    if (preview) URL.revokeObjectURL(preview.objectUrl);
    setPreview(null);
  }

  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, width: "100%", maxWidth: 440 }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 10 }]}>
          <FileText size={20} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>{name}</Text>
          <Text numberOfLines={1} style={[s.small, { fontSize: 12 }]}>
            {summary || "Delegated result"}
          </Text>
        </View>
      </View>
      {result.report ? (
        <View style={{ backgroundColor: "#FAFAFB", borderRadius: 12, padding: 13 }}>
          <AssistantResponse content={result.report} />
        </View>
      ) : null}
      {result.artifacts.map((artifact) => {
        // Inline reading is a web convenience; everywhere else the row saves.
        const kind =
          Platform.OS === "web" && artifact.path ? previewKind(artifact.path) : undefined;
        return (
          <Pressable
            key={artifact.id ?? artifact.path ?? artifact.title}
            accessibilityRole={artifact.path ? "button" : "text"}
            accessibilityLabel={
              artifact.path
                ? kind
                  ? `Preview ${artifact.title}`
                  : `Download ${artifact.title}`
                : artifact.title
            }
            // A widget or chart with no file behind it is reported, not offered:
            // there are no bytes to open until its renderer lands.
            disabled={!artifact.path || !!busy}
            onPress={() => {
              if (!artifact.path) return;
              if (kind) void show(artifact.path, artifact.title, kind);
              else void open(artifact.path);
            }}
            style={[s.row, { gap: 10, backgroundColor: "#FAFAFB", borderRadius: 12, padding: 10 }]}
          >
            <FileText size={16} color={colors.blueDark} />
            <View style={{ flex: 1, gap: 1 }}>
              <Text numberOfLines={1} style={[s.text, { fontSize: 14 }]}>
                {artifact.title}
              </Text>
              <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
                {[artifact.status, artifact.type].filter(Boolean).join(" · ")}
              </Text>
            </View>
            {busy === artifact.path ? (
              <ActivityIndicator size="small" color={colors.blueDark} />
            ) : artifact.path && kind ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Download ${artifact.title}`}
                onPress={() => artifact.path && void open(artifact.path)}
                hitSlop={8}
              >
                <Download size={16} color={colors.muted} />
              </Pressable>
            ) : artifact.path ? (
              <Download size={16} color={colors.muted} />
            ) : null}
          </Pressable>
        );
      })}
      {result.sources.map((source) => (
        // A source is its address, or its title when the delegate gave none.
        <View key={source.url ?? source.title ?? "source"} style={{ gap: 6 }}>
          <View style={[s.row, { gap: 8 }]}>
            <Link2 size={15} color={colors.muted} />
            <Text numberOfLines={2} style={[s.small, { color: colors.text, flex: 1 }]}>
              {source.title || source.url}
            </Text>
          </View>
          {source.url && (
            <Button
              small
              onPress={() => {
                if (!isSafeAssistantUrl(source.url as string)) return;
                setLinkError("");
                void Linking.openURL(source.url as string).catch((e) =>
                  setLinkError(e instanceof Error ? e.message : String(e)),
                );
              }}
            >
              Open source
            </Button>
          )}
        </View>
      ))}
      <ErrorNotice error={error || linkError} />
      {preview ? (
        <Sheet wide title={preview.title} subtitle={preview.path} onClose={closePreview}>
          <View style={{ gap: 12 }}>
            <ArtifactFrame
              objectUrl={preview.objectUrl}
              kind={preview.kind}
              title={preview.title}
            />
            <View style={[s.row, { gap: 8 }]}>
              <Button
                small
                icon={ExternalLink}
                onPress={() => window.open(preview.objectUrl, "_blank", "noopener")}
              >
                Open in a new tab
              </Button>
              <Button small icon={Download} onPress={() => void open(preview.path)}>
                Download
              </Button>
            </View>
          </View>
        </Sheet>
      ) : null}
    </Card>
  );
}
