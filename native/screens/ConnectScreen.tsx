import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
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
import Icon from "../components/Icon";

const GITHUB_URL = "https://github.com/AwsomeFox/tomesonic-app";

export default function ConnectScreen() {
  const colors = useThemeColors();
  const { login, serverConnectionConfig, setServerConnectionConfig } = useUserStore();
  const [address, setAddress] = useState(serverConnectionConfig?.address || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showAuthFields, setShowAuthFields] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authMethods, setAuthMethods] = useState<string[]>([]);
  const [oauthButtonText, setOauthButtonText] = useState("Login with OpenID");

  const isLocalAuth = authMethods.includes("local") || authMethods.length === 0;
  const isOpenIDAuth = authMethods.includes("openid");

  // Build the stored config from an ABS user payload and persist the session.
  const finishLogin = (user: any) => {
    const token = user.accessToken || user.token;
    const refreshToken = user.refreshToken || null;
    login(
      {
        address: address.replace(/\/$/, ""),
        userId: user.id,
        username: user.username,
        token,
        refreshToken,
        name: address.replace(/^https?:\/\//, ""),
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
      // Clean and validate URL formatting
      let cleanUrl = address.trim().replace(/\/$/, "");
      if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
        cleanUrl = "http://" + cleanUrl;
      }

      // Verify this is a reachable Audiobookshelf server and discover which
      // auth methods it supports (local, openid).
      const statusRes = await axios.get(`${cleanUrl}/status`, { timeout: 10000 });
      if (!statusRes.data || statusRes.data.app !== "audiobookshelf") {
        setError("This does not appear to be an Audiobookshelf server.");
        return;
      }

      setAuthMethods(statusRes.data.authMethods || []);
      setOauthButtonText(
        statusRes.data.authFormData?.authOpenIDButtonText || "Login with OpenID"
      );
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

    try {
      const response = await axios.post(
        `${address.replace(/\/$/, "")}/login`,
        { username: username.trim(), password },
        { headers: { "Content-Type": "application/json" }, timeout: 15000 }
      );

      const user = response.data?.user;
      if (!user) {
        setError("Authentication failed. Please check your credentials.");
        return;
      }
      finishLogin(user);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        setError("Invalid username or password.");
      } else {
        setError("Authentication failed. Please check your credentials.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOpenId = async () => {
    setError("");
    setLoading(true);
    try {
      const user = await loginWithOpenId(address);
      if (user) finishLogin(user);
    } catch (err: any) {
      setError(err?.message || "OpenID login failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleEditAddress = () => {
    setError("");
    setShowAuthFields(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Brand header: real TomeSonic logo + title, centered like the original */}
        <View style={{ alignItems: "center", marginBottom: 32 }}>
          <Image
            source={require("../assets/icon.png")}
            style={{ width: 96, height: 96, marginBottom: 8 }}
            resizeMode="contain"
          />
          <Text style={{ color: colors.onSurface, fontSize: 28, fontFamily: "sans-serif", fontWeight: "800" }}>
            TomeSonic
          </Text>
        </View>

        {/* Surface card holding the current step's fields */}
        <View style={{ width: "100%", maxWidth: 400, alignSelf: "center", backgroundColor: colors.surfaceContainer, borderWidth: 1, borderColor: colors.outlineVariant, padding: 24, borderRadius: 24, elevation: 1 }}>
          {!showAuthFields ? (
            /* Step 1 — Server address */
            <View>
              <Text style={{ color: colors.onSurface, fontSize: 22, fontFamily: "sans-serif", fontWeight: "bold", marginBottom: 12 }}>
                Server address
              </Text>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder="http://55.55.55.55:13378"
                placeholderTextColor={colors.onSurfaceVariant + "80"}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onSubmitEditing={handleConnectAddress}
                returnKeyType="go"
                style={{ backgroundColor: colors.surface, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.outline, fontSize: 16, color: colors.onSurface, fontFamily: "sans-serif" }}
              />
              <Pressable
                onPress={handleConnectAddress}
                disabled={loading}
                style={({ pressed }) => ({
                  backgroundColor: colors.primary,
                  marginTop: 24,
                  paddingVertical: 14,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 28,
                  elevation: 1,
                  opacity: pressed ? 0.95 : 1,
                  transform: [{ scale: pressed ? 0.98 : 1 }]
                })}
              >
                {loading ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={{ color: colors.onPrimary, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }}>
                    Submit
                  </Text>
                )}
              </Pressable>
            </View>
          ) : (
            /* Step 2 — Credentials */
            <View>
              {/* Selected server address with edit affordance */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text
                  style={{ color: colors.onSurfaceVariant, fontSize: 14, fontFamily: "sans-serif", flex: 1, marginRight: 8 }}
                  numberOfLines={1}
                >
                  {address}
                </Text>
                <Pressable
                  onPress={handleEditAddress}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    opacity: pressed ? 0.6 : 1
                  })}
                >
                  <Icon name="edit" size={18} color={colors.onSurfaceVariant} />
                </Pressable>
              </View>
              <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginVertical: 16 }} />

              {/* Local username/password auth */}
              {isLocalAuth ? (
                <View>
                  <TextInput
                    value={username}
                    onChangeText={setUsername}
                    placeholder="Username"
                    placeholderTextColor={colors.onSurfaceVariant + "80"}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ backgroundColor: colors.surface, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.outline, fontSize: 16, color: colors.onSurface, fontFamily: "sans-serif", marginBottom: 12 }}
                  />
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Password"
                    placeholderTextColor={colors.onSurfaceVariant + "80"}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={handleLogin}
                    returnKeyType="go"
                    style={{ backgroundColor: colors.surface, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.outline, fontSize: 16, color: colors.onSurface, fontFamily: "sans-serif" }}
                  />
                  <Pressable
                    onPress={handleLogin}
                    disabled={loading}
                    style={({ pressed }) => ({
                      backgroundColor: colors.primary,
                      marginTop: 24,
                      paddingVertical: 14,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 28,
                      elevation: 1,
                      opacity: pressed ? 0.95 : 1,
                      transform: [{ scale: pressed ? 0.98 : 1 }]
                    })}
                  >
                    {loading ? (
                      <ActivityIndicator color={colors.onPrimary} />
                    ) : (
                      <Text style={{ color: colors.onPrimary, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }}>
                        Submit
                      </Text>
                    )}
                  </Pressable>
                </View>
              ) : null}

              {/* Divider between local + OpenID when both are available */}
              {isLocalAuth && isOpenIDAuth ? (
                <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginVertical: 16 }} />
              ) : null}

              {/* OpenID / SSO auth */}
              {isOpenIDAuth ? (
                <Pressable
                  onPress={handleOpenId}
                  disabled={loading}
                  style={({ pressed }) => ({
                    borderWidth: 1,
                    borderColor: colors.primary,
                    paddingVertical: 14,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 28,
                    opacity: pressed ? 0.95 : 1,
                    transform: [{ scale: pressed ? 0.98 : 1 }]
                  })}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <Text style={{ color: colors.primary, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }}>
                      {oauthButtonText}
                    </Text>
                  )}
                </Pressable>
              ) : null}
            </View>
          )}

          {/* Inline error banner */}
          {error ? (
            <View style={{ marginTop: 16, padding: 12, backgroundColor: "rgba(179, 38, 30, 0.1)", borderWidth: 1, borderColor: "rgba(179, 38, 30, 0.5)", borderRadius: 12, flexDirection: "row", alignItems: "center" }}>
              <Icon name="warning" size={18} color={colors.error || "#B3261E"} />
              <Text style={{ color: colors.error || "#B3261E", fontSize: 14, fontFamily: "sans-serif", flex: 1, marginLeft: 8 }}>
                {error}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Red disclaimer below the card */}
        <Text style={{ color: colors.error || "#B3261E", fontSize: 14, fontFamily: "sans-serif", textAlign: "center", maxWidth: 400, alignSelf: "center", marginTop: 16, paddingHorizontal: 8 }}>
          Important! This app is designed to work with an Audiobookshelf server that
          you or someone you know is hosting. This app does not provide any content.
        </Text>
      </ScrollView>

      {/* Footer — Follow the project on Github */}
      <Pressable
        onPress={() => Linking.openURL(GITHUB_URL)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 16,
          opacity: pressed ? 0.6 : 1
        })}
      >
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontFamily: "sans-serif", marginRight: 8 }}>
          Follow the project on Github
        </Text>
        <Icon name="globe" size={22} color={colors.onSurfaceVariant} />
      </Pressable>
    </SafeAreaView>
  );
}
