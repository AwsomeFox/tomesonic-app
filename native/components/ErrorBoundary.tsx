import React from "react";
import { View, Text, Pressable } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { appLogger } from "../utils/logger";
import { Sentry } from "../utils/sentry";

interface ErrorFallbackProps {
  error: Error;
  onReset: () => void;
}

// Themed fallback UI shown when the boundary catches a render error. A
// separate function component so it can use the useThemeColors hook (class
// components can't use hooks directly).
function ErrorFallback({ error, onReset }: ErrorFallbackProps) {
  const colors = useThemeColors();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.surface,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <Icon name="warning" size={48} color={colors.error} />
      <Text
        style={{
          color: colors.onSurface,
          fontSize: 18,
          fontWeight: "600",
          marginTop: 16,
          textAlign: "center",
        }}
      >
        Something went wrong
      </Text>
      <Text
        style={{
          color: colors.onSurfaceVariant,
          fontSize: 13,
          marginTop: 8,
          textAlign: "center",
        }}
      >
        {error.message || "An unexpected error occurred."}
      </Text>
      <Pressable
        onPress={onReset}
        accessibilityRole="button"
        accessibilityLabel="Reload the app"
        style={{
          marginTop: 24,
          backgroundColor: colors.primary,
          paddingHorizontal: 24,
          paddingVertical: 12,
          borderRadius: 24,
        }}
      >
        <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Reload</Text>
      </Pressable>
      <Text
        style={{
          color: colors.onSurfaceVariant,
          fontSize: 12,
          marginTop: 16,
          textAlign: "center",
        }}
      >
        If this keeps happening, close and reopen the app.
      </Text>
    </View>
  );
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Top-level catch-all so a render error in any screen shows a themed fallback
// instead of a blank/crashed app. The only class component in the codebase —
// error boundaries require componentDidCatch/getDerivedStateFromError, which
// have no hook equivalent.
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    appLogger.error(error.message + " " + info.componentStack, "ErrorBoundary");
    // Report to crash reporting (no-op unless Sentry was initialized).
    Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onReset={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
