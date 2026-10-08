import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { API_URL } from "./api";
import {
  type Auth,
  authMode,
  openLocalSession,
  sendEmailCode,
  signInWithPassword,
  signUpWithPassword,
  verifyEmailCode,
} from "./session";
import { Button, Card, colors, ErrorNotice, Field, Mascot, s } from "./ui";

type Method = "password" | "code";

/** Supabase projects only sign in with a confirmed email, so the two steps stay separate. */
export function SignInScreen({ auth }: { auth: Auth }) {
  const [method, setMethod] = useState<Method>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [sent, setSent] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const sendCode = async () => {
    setSending(true);
    setSendError("");
    try {
      await sendEmailCode(email);
      setSent(email.trim());
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  if (authMode === "local")
    return (
      <Shell>
        <Card style={{ width: "100%" }}>
          <ErrorNotice error={auth.error} />
          <Field
            label="Workspace access key"
            value={accessKey}
            onChangeText={setAccessKey}
            secureTextEntry
            placeholder="Required for a live workspace"
          />
          <Button
            primary
            busy={auth.busy}
            onPress={() => void auth.submit(() => openLocalSession(accessKey || undefined))}
          >
            Open workspace
          </Button>
          <Text style={[s.small, { marginTop: 15 }]}>
            EXPO_PUBLIC_AUTH_MODE=local keeps the single-owner access key. Turn it off to sign in
            with Supabase instead.
          </Text>
        </Card>
      </Shell>
    );

  return (
    <Shell>
      <Card style={{ width: "100%" }}>
        <ErrorNotice error={auth.error} />
        <View style={[s.row, { gap: 8, marginBottom: 18 }]}>
          <MethodTab
            label="Email & password"
            active={method === "password"}
            onPress={() => setMethod("password")}
          />
          <MethodTab
            label="Email code"
            active={method === "code"}
            onPress={() => setMethod("code")}
          />
        </View>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
        />
        {method === "password" ? (
          <>
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              placeholder="At least 6 characters"
            />
            <Button
              primary
              busy={auth.busy}
              onPress={() => void auth.submit(() => signInWithPassword(email, password))}
            >
              Sign in
            </Button>
            <View style={{ height: 10 }} />
            <Button
              disabled={auth.busy}
              onPress={() => void auth.submit(() => signUpWithPassword(email, password))}
            >
              Create account
            </Button>
          </>
        ) : (
          <>
            <Button primary busy={sending} disabled={!email.trim()} onPress={() => void sendCode()}>
              Email me a code
            </Button>
            <ErrorNotice error={sendError} />
            {!!sent && (
              <>
                <View style={{ height: 10 }} />
                <Field
                  label="Code"
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  placeholder="123456"
                />
                <Button
                  primary
                  busy={auth.busy}
                  onPress={() => void auth.submit(() => verifyEmailCode(email, code))}
                >
                  Verify code
                </Button>
                <Text style={[s.small, { marginTop: 12 }]}>Code sent to {sent}.</Text>
              </>
            )}
          </>
        )}
        <Text style={[s.small, { marginTop: 15 }]}>
          Sign in with the same account your OpenMuse server verifies, then the app opens the
          workspace at {API_URL}.
        </Text>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: colors.canvas,
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
      }}
    >
      <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
        <Mascot size={72} />
        <Text style={{ fontSize: 32, color: colors.text, letterSpacing: -1, fontWeight: "500" }}>
          Welcome to OpenMuse.
        </Text>
        <Text style={[s.muted, { textAlign: "center" }]}>A little room for your day.</Text>
        {children}
      </View>
    </SafeAreaView>
  );
}

function MethodTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        backgroundColor: active ? colors.text : colors.canvas,
      }}
    >
      <Text style={[s.small, { fontWeight: "600", color: active ? "#FFF" : colors.muted }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SignInSplash({ label }: { label: string }) {
  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: colors.canvas,
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
      }}
    >
      <ActivityIndicator color={colors.blueDark} />
      <Text style={s.muted}>{label}</Text>
    </SafeAreaView>
  );
}
