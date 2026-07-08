import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Linking,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import axios from "axios";
import { useUserStore } from "../store/useUserStore";
import { loginWithOpenId } from "../utils/oauth";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import Pressable from "../components/HintPressable";

const GITHUB_URL = "https://github.com/AwsomeFox/tomesonic-app";

// A failed TLS handshake (self-signed / untrusted cert) surfaces through axios
// as a generic "Network Error", but the underlying platform message names the
// cause. Sniff it so we can tell the user it's a certificate problem, not a
// wrong URL.
function isTlsError(err: any): boolean {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("certificate") ||
    msg.includes("trust anchor") ||
    msg.includes("sslhandshake") ||
    msg.includes("ssl handshake") ||
    msg.includes("cert_") ||
    msg.includes("self-signed") ||
    msg.includes("self signed") ||
    msg.includes("certpathvalidator")
  );
}

// A connection-LEVEL failure — the transport never established, so the host is
// likely down / unreachable (as opposed to a TLS handshake that DID reach the
// host but presented an untrusted cert). Used to keep the "install a
// certificate" advice from firing when a plain refusal is also in play.
function isConnRefusedError(err: any): boolean {
  const msg = String(err?.message || "").toLowerCase();
  const code = String(err?.code || "").toLowerCase();
  return (
    msg.includes("econnrefused") ||
    code.includes("econnrefused") ||
    msg.includes("connection refused") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("etimedout") ||
    code.includes("etimedout") ||
    msg.includes("timeout")
  );
}

// --- Saved-server memory (PO#2) --------------------------------------------
// A tiny, NON-SECRET record of servers the user has previously signed into so
// switching servers doesn't require retyping the full URL. We persist ONLY the
// address, username, and auth method — never passwords, tokens, or refresh
// tokens (those live encrypted in secureStorage and are wiped on switch).
const SAVED_SERVERS_KEY = "savedServers";
const MAX_SAVED_SERVERS = 5;

interface SavedServer {
  address: string;
  username?: string;
  authMethod?: "local" | "openid";
  lastUsedAt?: number;
}

function loadSavedServers(): SavedServer[] {
  try {
    const { storage } = require("../utils/storage");
    const raw = storage.getString(SAVED_SERVERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s: any) => s && typeof s.address === "string" && s.address)
      .map((s: any) => ({
        address: s.address,
        username: typeof s.username === "string" ? s.username : undefined,
        authMethod: s.authMethod === "openid" ? "openid" : s.authMethod === "local" ? "local" : undefined,
        lastUsedAt: typeof s.lastUsedAt === "number" ? s.lastUsedAt : undefined,
      }));
  } catch {
    return [];
  }
}

function persistSavedServer(entry: SavedServer) {
  try {
    const { storage } = require("../utils/storage");
    // Only the three non-secret fields ever get written.
    const clean: SavedServer = {
      address: entry.address,
      username: entry.username || undefined,
      authMethod: entry.authMethod,
      lastUsedAt: Date.now(),
    };
    // Most-recent-first, de-duped by address (case-insensitive), capped.
    const deduped = loadSavedServers().filter(
      (s) => s.address.toLowerCase() !== clean.address.toLowerCase()
    );
    const next = [clean, ...deduped].slice(0, MAX_SAVED_SERVERS);
    storage.set(SAVED_SERVERS_KEY, JSON.stringify(next));
  } catch {
    // best-effort — the app still works without saved-server memory.
  }
}

/** Strip scheme + trailing slash for a compact chip label. */
function serverHostLabel(addr: string): string {
  return addr.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// M3 Expressive control metrics for this screen: hero-size touch targets.
const FIELD_HEIGHT = 56;
const BUTTON_HEIGHT = 56;

export default function ConnectScreen() {
  const colors = useThemeColors();
  const { login, serverConnectionConfig } = useUserStore();
  // Previously-connected servers (address + username + authMethod, no secrets).
  const [savedServers, setSavedServers] = useState<SavedServer[]>(loadSavedServers);
  // Seed the address from the active config if present, else from the most
  // recently used saved server — so after a server switch (config is null) the
  // last address stays prefilled instead of forcing a full retype.
  const [address, setAddress] = useState(
    serverConnectionConfig?.address || savedServers[0]?.address || ""
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showAuthFields, setShowAuthFields] = useState(false);
  const [loading, setLoading] = useState(false);
  // Which auth flow is in flight — a single flag put a spinner on BOTH
  // buttons when a server offers local + OpenID.
  const [authFlow, setAuthFlow] = useState<"local" | "oauth" | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  // Focused-field key drives the M3 filled-field focus ring.
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [authMethods, setAuthMethods] = useState<string[]>([]);
  const [oauthButtonText, setOauthButtonText] = useState("Login with OpenID");
  // From /status — persisted into the connection config so the Account
  // screen's "Server version" line can actually render.
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  const isLocalAuth = authMethods.includes("local") || authMethods.length === 0;
  const isOpenIDAuth = authMethods.includes("openid");

  // If the app force-logged the user out (token refresh definitively
  // rejected), say so — landing here silently read as "the app randomly
  // logged me out".
  useEffect(() => {
    try {
      const { storage } = require("../utils/storage");
      if (storage.getString("logout_reason") === "session_expired") {
        storage.remove("logout_reason");
        setError("Your session expired — please sign in again.");
      }
    } catch {}
  }, []);

  // Build the stored config from an ABS user payload and persist the session.
  // Awaited by callers so the loading spinner covers login's account-switch
  // cleanup (download/cache wipes) instead of leaving the form interactive.
  const finishLogin = async (user: any, method: "local" | "openid" = "local") => {
    const token = user.accessToken || user.token;
    // A 200 login whose user carries NO token (misconfigured proxy stripping
    // fields) must not "log in" — the app entered the main stack with
    // token:undefined and silently bounced back to Connect on next cold start.
    if (!token) {
      setError("Authentication failed. Please check your credentials.");
      return;
    }
    const refreshToken = user.refreshToken || null;
    // Don't keep the password in component state any longer than needed — the
    // session tokens are what get persisted, never the password itself.
    setPassword("");
    // Remember this server (address + username + method — NO secrets) so a
    // later switch back can prefill it as a tappable chip.
    persistSavedServer({
      address: address.replace(/\/+$/, ""),
      username: user.username || username || undefined,
      authMethod: method,
    });
    setSavedServers(loadSavedServers());
    await login(
      {
        address: address.replace(/\/+$/, ""),
        userId: user.id,
        username: user.username,
        token,
        refreshToken,
        name: address.replace(/^https?:\/\//, ""),
        // Persist how we authenticated so account-only-relevant UI (e.g. the
        // Change Password row, which an OpenID/SSO account has no local
        // password for) can gate on it.
        authMethod: method,
        ...(serverVersion ? { version: serverVersion } : {}),
      },
      user
    );
  };

  const handleConnectAddress = async () => {
    if (!address.trim()) {
      setError("Please enter a server address");
      return;
    }
    setError("");
    setLoading(true);

    try {
      // Clean and validate URL formatting. A bare hostname tries https://
      // first, falling back to http:// — most real ABS deployments sit behind
      // TLS (reverse proxy / abs.example.com), and defaulting to http:// made
      // those fail outright (or sent credentials in the clear when the server
      // answered on both).
      const trimmed = address.trim().replace(/\/+$/, "");
      const hasScheme = trimmed.startsWith("http://") || trimmed.startsWith("https://");
      const candidates = hasScheme ? [trimmed] : [`https://${trimmed}`, `http://${trimmed}`];

      // Verify this is a reachable Audiobookshelf server and discover which
      // auth methods it supports (local, openid).
      let cleanUrl = candidates[0];
      let statusRes: any = null;
      let sawTlsError = false;
      let sawConnRefused = false;
      for (let i = 0; i < candidates.length; i++) {
        try {
          statusRes = await axios.get(`${candidates[i]}/status`, { timeout: 10000 });
          cleanUrl = candidates[i];
          break;
        } catch (err) {
          if (isTlsError(err)) sawTlsError = true;
          if (isConnRefusedError(err)) sawConnRefused = true;
        }
      }
      if (!statusRes) {
        // Pick the least-misleading message. A self-signed / untrusted cert
        // fails the TLS handshake with a message the user can't act on
        // ("Network Error"), so we DO want to name the cert problem — but only
        // when it's the DEFINITIVE failure. For a bare host the candidates are
        // [https://host, http://host]: if https hits a cert error but http is
        // refused, the server may simply be down or only reachable over http,
        // and telling the user to install a certificate sends them chasing the
        // wrong fix. So only surface the cert-install message when a genuine
        // cert error occurred AND no candidate got a connection-level refusal.
        if (sawTlsError && !sawConnRefused) {
          setError(
            "Couldn't verify this server's security certificate. A self-signed certificate isn't trusted on this device — install it in Android settings, or use a domain with a valid certificate."
          );
        } else if (sawTlsError && sawConnRefused) {
          // TLS failed on https and http was refused — reachability, not certs,
          // is the likely problem. Prefer a "couldn't reach" message.
          setError(
            "Couldn't reach the server. It may be offline or only reachable over http — check the address and that the server is running."
          );
        } else {
          setError("Unable to connect to the server. Please verify the URL.");
        }
        return;
      }
      if (!statusRes.data || statusRes.data.app !== "audiobookshelf") {
        setError("This does not appear to be an Audiobookshelf server.");
        return;
      }

      setAuthMethods(statusRes.data.authMethods || []);
      setOauthButtonText(
        statusRes.data.authFormData?.authOpenIDButtonText || "Login with OpenID"
      );
      setServerVersion(statusRes.data.serverVersion || null);
      setAddress(cleanUrl);
      setShowAuthFields(true);
    } catch (err) {
      setError("Unable to connect to the server. Please verify the URL.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError("Please enter username and password");
      return;
    }
    setError("");
    setLoading(true);
    setAuthFlow("local");

    try {
      const response = await axios.post(
        `${address.replace(/\/+$/, "")}/login`,
        { username: username.trim(), password },
        { headers: { "Content-Type": "application/json" }, timeout: 15000 }
      );

      const user = response.data?.user;
      if (!user) {
        setError("Authentication failed. Please check your credentials.");
        return;
      }
      await finishLogin(user);
    } catch (err: any) {
      // Differentiate the failure so the message is actionable: only an auth
      // rejection means "check your credentials". A network/timeout, rate
      // limit, or server error are NOT the user's password being wrong.
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        setError("Invalid username or password.");
      } else if (!err?.response) {
        // No HTTP response — request never reached the server (offline,
        // timeout, DNS/refused, wrong address).
        setError("Couldn't reach the server. Check the address and your connection.");
      } else if (status === 429) {
        setError("Too many attempts. Please wait a moment and try again.");
      } else if (status >= 500) {
        setError("The server had a problem. Please try again.");
      } else {
        setError("Authentication failed. Please check your credentials.");
      }
    } finally {
      setLoading(false);
      setAuthFlow(null);
    }
  };

  const handleOpenId = async () => {
    setError("");
    setLoading(true);
    setAuthFlow("oauth");
    try {
      const user = await loginWithOpenId(address);
      if (user) await finishLogin(user, "openid");
    } catch (err: any) {
      setError(err?.message || "OpenID login failed.");
    } finally {
      setLoading(false);
      setAuthFlow(null);
    }
  };

  const handleEditAddress = () => {
    setError("");
    setShowAuthFields(false);
  };

  // Tapping a saved-server chip prefills the address (and username) fields so
  // the user only has to enter their password to switch servers.
  const handleUseSavedServer = (server: SavedServer) => {
    setError("");
    setAddress(server.address);
    if (server.username) setUsername(server.username);
  };

  // --- M3 Expressive building blocks -------------------------------------

  /** Filled text field: tonal fill, rounded corners, primary focus ring. */
  const fieldStyle = (key: string, extra?: object) => ({
    backgroundColor: colors.surfaceContainerHighest,
    minHeight: FIELD_HEIGHT,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: focusedField === key ? colors.primary : "transparent",
    fontSize: 16,
    color: colors.onSurface,
    fontFamily: "sans-serif",
    ...(extra || {}),
  });

  /** Hero button: full-width 56dp pill. variant "filled" | "tonal". */
  const BigButton = ({
    label,
    onPress,
    busy,
    variant = "filled",
    compact = false,
  }: {
    label: string;
    onPress: () => void;
    busy?: boolean;
    variant?: "filled" | "tonal";
    /** Self-sized pill instead of full width (for aligned action rows). */
    compact?: boolean;
  }) => {
    const bg = variant === "filled" ? colors.primary : colors.secondaryContainer;
    const fg = variant === "filled" ? colors.onPrimary : colors.onSecondaryContainer;
    return (
      <Pressable
        onPress={onPress}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: loading, busy: !!busy }}
        android_ripple={{ color: withAlpha(fg, 0.12) }}
        // Plain object style — Fabric drops function-styles on this
        // pressable path on-device; the ripple supplies pressed feedback.
        style={{
          backgroundColor: bg,
          minHeight: BUTTON_HEIGHT,
          alignItems: "center" as const,
          justifyContent: "center" as const,
          borderRadius: BUTTON_HEIGHT / 2,
          overflow: "hidden" as const,
          ...(compact ? { paddingHorizontal: 32, minWidth: 140 } : null),
          elevation: variant === "filled" ? 2 : 0,
          opacity: loading && !busy ? 0.6 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color={fg} />
        ) : (
          <Text
            style={{
              color: fg,
              fontSize: 17,
              fontFamily: "sans-serif",
              fontWeight: "700",
              letterSpacing: 0.2,
            }}
          >
            {label}
          </Text>
        )}
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Brand header: logo + expressive display title */}
        <View style={{ alignItems: "center", marginBottom: 28 }}>
          <Image
            source={require("../assets/icon.png")}
            style={{ width: 104, height: 104, marginBottom: 10 }}
            resizeMode="contain"
          />
          <Text style={{ color: colors.onSurface, fontSize: 32, fontFamily: "serif", fontWeight: "800", letterSpacing: -0.5 }}>
            TomeSonic
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, fontFamily: "sans-serif", marginTop: 4 }}>
            Your audiobooks, your server
          </Text>
        </View>

        {/* Tonal card holding the current step */}
        <View
          style={{
            width: "100%",
            maxWidth: 420,
            alignSelf: "center",
            backgroundColor: colors.surfaceContainer,
            padding: 24,
            borderRadius: 28,
          }}
        >
          {!showAuthFields ? (
            /* Step 1 — Server address */
            <View>
              <Text style={{ color: colors.onSurface, fontSize: 26, fontFamily: "sans-serif", fontWeight: "800", letterSpacing: -0.3 }}>
                Server address
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontFamily: "sans-serif", marginTop: 4, marginBottom: 20 }}>
                Point TomeSonic at your Audiobookshelf server to get started.
              </Text>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder="http://55.55.55.55:13378"
                placeholderTextColor={withAlpha(colors.onSurfaceVariant, 0.55)}
                accessibilityLabel="Server address input"
                testID="server-address-input"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onFocus={() => setFocusedField("address")}
                onBlur={() => setFocusedField(null)}
                onSubmitEditing={handleConnectAddress}
                returnKeyType="go"
                style={fieldStyle("address")}
              />

              {/* Saved-server chips (PO#2) — tap to prefill a previously
                  connected server so switching doesn't require a full retype.
                  Only non-secret fields (address/username) are ever stored. */}
              {savedServers.length > 0 ? (
                <View style={{ marginTop: 16 }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontFamily: "sans-serif", marginBottom: 8 }}>
                    Recent servers
                  </Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {savedServers.map((server) => {
                      const host = serverHostLabel(server.address);
                      return (
                        <Pressable
                          key={server.address}
                          onPress={() => handleUseSavedServer(server)}
                          accessibilityRole="button"
                          accessibilityLabel={`Use saved server ${host}`}
                          testID={`saved-server-${host}`}
                          hitSlop={{ top: 8, bottom: 8 }}
                          android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
                          style={{
                            flexDirection: "row" as const,
                            alignItems: "center" as const,
                            backgroundColor: colors.surfaceContainerHighest,
                            borderRadius: 12,
                            paddingHorizontal: 14,
                            paddingVertical: 8,
                            borderWidth: 1,
                            borderColor: colors.outlineVariant,
                            overflow: "hidden" as const,
                          }}
                        >
                          <Icon name="globe" size={14} color={colors.onSurfaceVariant} />
                          <Text
                            style={{ color: colors.onSurface, fontSize: 13, fontFamily: "sans-serif", marginLeft: 8, maxWidth: 220 }}
                            numberOfLines={1}
                          >
                            {host}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              <View style={{ marginTop: 24, alignItems: "flex-end" }}>
                <BigButton label="Submit" onPress={handleConnectAddress} busy={loading} compact />
              </View>
            </View>
          ) : (
            /* Step 2 — Credentials */
            <View>
              <Text style={{ color: colors.onSurface, fontSize: 26, fontFamily: "sans-serif", fontWeight: "800", letterSpacing: -0.3, marginBottom: 16 }}>
                Sign in
              </Text>

              {/* Connected server chip — tap to change the address */}
              <Pressable
                onPress={handleEditAddress}
                accessibilityRole="button"
                accessibilityLabel="Change server address"
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.12) }}
                style={{
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  backgroundColor: colors.secondaryContainer,
                  borderRadius: 16,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  marginBottom: 16,
                  overflow: "hidden" as const,
                }}
              >
                <Icon name="globe" size={20} color={colors.onSecondaryContainer} />
                <Text
                  style={{ color: colors.onSecondaryContainer, fontSize: 14, fontFamily: "sans-serif", fontWeight: "600", flex: 1, marginHorizontal: 10 }}
                  numberOfLines={1}
                >
                  {address}
                </Text>
                <Icon name="edit" size={18} color={colors.onSecondaryContainer} />
              </Pressable>

              {/* Cleartext warning — plain-http LAN servers are supported on
                  purpose (usesCleartextTraffic), but the user should know the
                  password and tokens travel unencrypted on this connection. */}
              {address.startsWith("http://") ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: colors.surfaceContainerHigh,
                    borderRadius: 14,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    marginBottom: 16,
                  }}
                >
                  <Icon name="warning" size={16} color={colors.onSurfaceVariant} />
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontFamily: "sans-serif", flex: 1, marginLeft: 10, lineHeight: 17 }}>
                    This connection uses unencrypted HTTP. Only sign in over a network you trust (e.g. your home LAN or a VPN).
                  </Text>
                </View>
              ) : null}

              {/* Local username/password auth */}
              {isLocalAuth ? (
                <View>
                  <TextInput
                    value={username}
                    onChangeText={setUsername}
                    placeholder="Username"
                    placeholderTextColor={withAlpha(colors.onSurfaceVariant, 0.55)}
                    accessibilityLabel="Username input"
                    testID="username-input"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onFocus={() => setFocusedField("username")}
                    onBlur={() => setFocusedField(null)}
                    style={fieldStyle("username", { marginBottom: 12 })}
                  />
                  <View style={{ position: "relative" }}>
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      placeholder="Password"
                      placeholderTextColor={withAlpha(colors.onSurfaceVariant, 0.55)}
                      accessibilityLabel="Password input"
                      testID="password-input"
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      onFocus={() => setFocusedField("password")}
                      onBlur={() => setFocusedField(null)}
                      onSubmitEditing={handleLogin}
                      returnKeyType="go"
                      style={fieldStyle("password", { paddingRight: 56 })}
                    />
                    <Pressable
                      onPress={() => setShowPassword((v) => !v)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                      style={{
                        position: "absolute",
                        right: 6,
                        top: 0,
                        bottom: 0,
                        width: 48,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name={showPassword ? "eye-off" : "eye"} size={22} color={colors.onSurfaceVariant} />
                    </Pressable>
                  </View>
                  <View style={{ marginTop: 24, alignItems: "flex-end" }}>
                    <BigButton label="Submit" onPress={handleLogin} busy={loading && authFlow === "local"} compact />
                  </View>
                </View>
              ) : null}

              {/* "or" divider between local + OpenID when both are available */}
              {isLocalAuth && isOpenIDAuth ? (
                <View style={{ flexDirection: "row", alignItems: "center", marginVertical: 18 }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.outlineVariant }} />
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontFamily: "sans-serif", marginHorizontal: 12 }}>
                    or
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.outlineVariant }} />
                </View>
              ) : null}

              {/* OpenID / SSO auth — tonal hero button */}
              {isOpenIDAuth ? (
                <View style={{ alignItems: "center" }}>
                  <BigButton
                    label={oauthButtonText}
                    onPress={handleOpenId}
                    busy={loading && authFlow === "oauth"}
                    variant="tonal"
                    compact
                  />
                </View>
              ) : null}
            </View>
          )}

          {/* Inline error banner — M3 error container. Live region so a
              failed login is announced instead of appearing silently. */}
          {error ? (
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{
                marginTop: 20,
                paddingHorizontal: 16,
                paddingVertical: 14,
                backgroundColor: colors.errorContainer,
                borderRadius: 16,
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <Icon name="warning" size={20} color={colors.onErrorContainer} />
              <Text style={{ color: colors.onErrorContainer, fontSize: 14, fontFamily: "sans-serif", flex: 1, marginLeft: 10, lineHeight: 19 }}>
                {error}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Disclaimer below the card */}
        <Text
          style={{
            color: colors.onSurfaceVariant,
            fontSize: 13,
            fontFamily: "sans-serif",
            textAlign: "center",
            maxWidth: 400,
            alignSelf: "center",
            marginTop: 20,
            paddingHorizontal: 8,
            lineHeight: 18,
          }}
        >
          Important! This app is designed to work with an Audiobookshelf server that
          you or someone you know is hosting. This app does not provide any content.
        </Text>
      </ScrollView>

      {/* Footer — Follow the project on GitHub */}
      <Pressable
        onPress={() => Linking.openURL(GITHUB_URL)}
        android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
        style={{
          flexDirection: "row" as const,
          alignItems: "center" as const,
          justifyContent: "center" as const,
          paddingVertical: 16,
        }}
      >
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontFamily: "sans-serif", marginRight: 8 }}>
          Follow the project on GitHub
        </Text>
        <Icon name="globe" size={22} color={colors.onSurfaceVariant} />
      </Pressable>
    </SafeAreaView>
  );
}
