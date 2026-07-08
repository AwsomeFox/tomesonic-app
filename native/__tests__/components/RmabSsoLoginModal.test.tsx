/**
 * RmabSsoLoginModal — the two security/correctness-critical seams:
 *   - onNavigationStateChange only injects the hash-capture JS on the EXACT
 *     RMAB origin (never a look-alike/prefix host, never the IdP).
 *   - onMessage parses the #authData bundle, fires onSuccess exactly once, and
 *     routes an unparseable payload to onError — both flipping the once-guard.
 * The WebView is a captured element (RNTL v14 has no UNSAFE_getByType), so we
 * drive its props directly and expose injectJavaScript through the ref.
 */
jest.mock(
  "react-native-webview",
  () => {
    const React = require("react");
    const inject = jest.fn();
    (global as any).__injectJS = inject;
    const WebView = React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ injectJavaScript: inject }));
      (global as any).__webViewProps = props;
      return React.createElement("WebView", props);
    });
    return { WebView };
  },
  { virtual: true }
);

import React from "react";
import { render } from "@testing-library/react-native";
import RmabSsoLoginModal from "../../components/RmabSsoLoginModal";

const ORIGIN = "https://rmab.test";

async function renderModal(overrides: Partial<React.ComponentProps<typeof RmabSsoLoginModal>> = {}) {
  const onSuccess = jest.fn();
  const onError = jest.fn();
  const onClose = jest.fn();
  await render(
    <RmabSsoLoginModal
      visible
      serverUrl={ORIGIN}
      onClose={onClose}
      onSuccess={onSuccess}
      onError={onError}
      {...overrides}
    />
  );
  return {
    onSuccess,
    onError,
    onClose,
    get props() {
      return (global as any).__webViewProps;
    },
    get inject() {
      return (global as any).__injectJS as jest.Mock;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("onNavigationStateChange origin guard", () => {
  it("injects the capture JS when navigation lands on the EXACT RMAB origin", async () => {
    const h = await renderModal();
    h.props.onNavigationStateChange({ url: `${ORIGIN}/api/auth/oidc/callback#authData=x` });
    expect(h.inject).toHaveBeenCalledTimes(1);
    // It injects the hash-reading capture script (posts back { authData }).
    expect(String(h.inject.mock.calls[0][0])).toContain("authData");
  });

  it("does NOT inject on a look-alike host, a prefix host, or the IdP origin", async () => {
    const h = await renderModal();
    // Look-alike / prefix host: a naive indexOf===0 check would match these.
    h.props.onNavigationStateChange({ url: "https://rmab.test.evil.com/api/auth/oidc/callback#authData=x" });
    h.props.onNavigationStateChange({ url: "https://rmab.testx.com/callback#authData=x" });
    // The IdP origin the flow redirects THROUGH must never see the capture JS.
    h.props.onNavigationStateChange({ url: "https://idp.example.com/authorize?client_id=rmab" });
    expect(h.inject).not.toHaveBeenCalled();
  });
});

describe("onMessage authData handling", () => {
  const authDataRaw = () =>
    encodeURIComponent(
      JSON.stringify({ accessToken: "a", refreshToken: "r", user: { id: "u1", username: "tony" } })
    );

  it("parses a valid bundle into a config and fires onSuccess exactly once", async () => {
    const h = await renderModal();
    const post = { nativeEvent: { data: JSON.stringify({ authData: authDataRaw() }) } };
    h.props.onMessage(post);
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        url: ORIGIN,
        accessToken: "a",
        refreshToken: "r",
        authProvider: "oidc",
      })
    );
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("swallows a second post of the same hash (once-only doneRef guard)", async () => {
    const h = await renderModal();
    const post = { nativeEvent: { data: JSON.stringify({ authData: authDataRaw() }) } };
    h.props.onMessage(post);
    // The capture JS re-runs on every navigation and could re-post the hash.
    h.props.onMessage(post);
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
  });

  it("routes an unparseable payload to onError and still sets the done guard", async () => {
    const h = await renderModal();
    h.props.onMessage({ nativeEvent: { data: JSON.stringify({ authData: "not-valid-json" }) } });
    expect(h.onError).toHaveBeenCalledWith("Could not read the sign-in response.");
    expect(h.onSuccess).not.toHaveBeenCalled();
    // doneRef is now set — a follow-up post (even a valid one) is ignored.
    h.props.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          authData: encodeURIComponent(JSON.stringify({ accessToken: "a", refreshToken: "r" })),
        }),
      },
    });
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it("ignores a message with no authData (unrelated postMessage)", async () => {
    const h = await renderModal();
    h.props.onMessage({ nativeEvent: { data: JSON.stringify({ foo: "bar" }) } });
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
});
