/**
 * RmabSessionExpiredBanner — renders only when the session is expired, and its
 * "Sign in" action forks on how the session was established: an OIDC session
 * relaunches the SSO WebView in place; anything else defers to onManualReconnect.
 * OIDC failures (connect returns false, or the WebView reports a parse error)
 * fall back to onManualReconnect so a dead session is never a silent dead end.
 * The SSO modal is stubbed to a visibility probe so the fork is observable.
 */
jest.mock("../../components/RmabSsoLoginModal", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: (props: any) => {
      (global as any).__ssoProps = props;
      return props.visible ? React.createElement(Text, null, "SSO_MODAL_OPEN") : null;
    },
  };
});

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import RmabSessionExpiredBanner from "../../components/RmabSessionExpiredBanner";
import { useRmabStore } from "../../store/useRmabStore";

const initial = useRmabStore.getState();

beforeEach(() => {
  useRmabStore.setState(initial, true);
  (global as any).__ssoProps = undefined;
  jest.clearAllMocks();
});

const ssoProps = () => (global as any).__ssoProps;

describe("RmabSessionExpiredBanner", () => {
  it("renders nothing when the session is not expired", async () => {
    useRmabStore.setState({ sessionExpired: false } as any);
    await render(<RmabSessionExpiredBanner onManualReconnect={jest.fn()} />);
    expect(screen.queryByText("Session expired")).toBeNull();
  });

  it("shows the banner and opens the SSO modal for an OIDC session", async () => {
    useRmabStore.setState({
      sessionExpired: true,
      authProvider: "oidc",
      serverUrl: "https://rmab.test",
    } as any);
    const onManualReconnect = jest.fn();
    await render(<RmabSessionExpiredBanner onManualReconnect={onManualReconnect} />);

    expect(screen.getByText("Session expired")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Sign in again to ReadMeABook"));

    // SSO (not the manual fallback) for an OIDC session.
    expect(await screen.findByText("SSO_MODAL_OPEN")).toBeTruthy();
    expect(onManualReconnect).not.toHaveBeenCalled();
  });

  it("defers to onManualReconnect when the session can't re-auth via SSO", async () => {
    // A login-token / API-key session has no silent SSO path.
    useRmabStore.setState({
      sessionExpired: true,
      authProvider: "loginToken",
      serverUrl: "https://rmab.test",
    } as any);
    const onManualReconnect = jest.fn();
    await render(<RmabSessionExpiredBanner onManualReconnect={onManualReconnect} />);

    await fireEvent.press(screen.getByLabelText("Sign in again to ReadMeABook"));
    expect(onManualReconnect).toHaveBeenCalledWith();
    // No SSO modal is even mounted for a non-OIDC session.
    expect(ssoProps()).toBeUndefined();
  });

  it("falls back to onManualReconnect when the OIDC reconnect returns false", async () => {
    const connectWithOidc = jest.fn().mockResolvedValue(false);
    useRmabStore.setState({
      sessionExpired: true,
      authProvider: "oidc",
      serverUrl: "https://rmab.test",
      connectWithOidc,
    } as any);
    const onManualReconnect = jest.fn();
    await render(<RmabSessionExpiredBanner onManualReconnect={onManualReconnect} />);
    await fireEvent.press(screen.getByLabelText("Sign in again to ReadMeABook"));

    await act(async () => {
      await ssoProps().onSuccess({ url: "https://rmab.test", accessToken: "a", refreshToken: "r" });
    });

    expect(connectWithOidc).toHaveBeenCalled();
    // Fallback carries no message — connectWithOidc already set the store error.
    expect(onManualReconnect).toHaveBeenCalledWith();
  });

  it("threads a message to onManualReconnect when the SSO WebView reports an error", async () => {
    useRmabStore.setState({
      sessionExpired: true,
      authProvider: "oidc",
      serverUrl: "https://rmab.test",
    } as any);
    const onManualReconnect = jest.fn();
    await render(<RmabSessionExpiredBanner onManualReconnect={onManualReconnect} />);
    await fireEvent.press(screen.getByLabelText("Sign in again to ReadMeABook"));

    await act(async () => {
      ssoProps().onError("Could not read the sign-in response.");
    });

    expect(onManualReconnect).toHaveBeenCalledWith("Sign-in failed — please try again.");
  });
});
