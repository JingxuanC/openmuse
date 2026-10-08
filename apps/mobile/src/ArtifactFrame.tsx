import { Text, View } from "react-native";
import { colors, s } from "./ui";

/**
 * Placeholder for platforms without a DOM frame: the preview is web-only for
 * now, and the card keeps the download/share flow everywhere else.
 */
export default function ArtifactFrame({
  title,
}: {
  objectUrl: string;
  kind: string;
  title: string;
}) {
  return (
    <View style={{ padding: 24, alignItems: "center", gap: 8 }}>
      <Text style={[s.text, { color: colors.muted }]}>
        {title} 的预览目前只在网页版可用，请用下载。
      </Text>
    </View>
  );
}
