/**
 * ConnectScreen — server address validation + /status discovery, cleartext
 * warning, local username/password login (success, 401, validation), OpenID
 * flow, and the edit-address affordance.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 320, height: 640 };
  return {
    SafeAreaProvider: ({ children }: any) => children,
    SafeAreaView: ({ children, edges, ...props }: any) => React.createElement(View, props, children),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { frame, insets },
  };
});

// The screen hits the server with RAW axios (no auth interceptors yet). The
// mock must also satisfy utils/api's module-load-time axios.create().
jest.mock("axios", () => {
  const instance = {
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: {},
  };
  const mockAxios: any = {
    get: jest.fn(),
    post: jest.fn(),
    create: jest.fn(() => instance),
    isAxiosError: (e: any) => !!e?.isAxiosError,
  };
  mockAxios.default = mockAxios;
  mockAxios.__esModule = true;
  return mockAxios;
});

jest.mock("../../utils/oauth", () => ({
  loginWithOpenId: jest.fn(),
}));

import axios from "axios";
import ConnectScreen from "../../screens/ConnectScreen";
import { loginWithOpenId } from "../../utils/oauth";
import { useUserStore } from "../../store/useUserStore";
import { storage } from "../../utils/storage";

const mockedGet = (axios as any).get as jest.Mock;
const mockedPost = (axios as any).post as jest.Mock;
const mockedOpenId = loginWithOpenId as jest.Mock;

const initialUser = useUserStore.getState();

const absStatus = (extra: Record<string, any> = {}) => ({
  data: { app: "audiobookshelf", serverVersion: "2.17.0", authMethods: ["local"], ...extra },
});

/** Enter an address and submit step 1. */
async function connect(address = "abs.example.com") {
  await fireEvent.changeText(screen.getByPlaceholderText("http://55.55.55.55:13378"), address);
  await fireEvent.press(screen.getByText("Submit"));
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useUserStore.setState({ serverConnectionConfig: null } as any);
  // Saved-server memory is persisted in the shared in-memory MMKV mock — clear
  // it so chips from one test don't leak into the next.
  storage.remove("savedServers");
});

describe("ConnectScreen", () => {
  it("renders the brand header and the server-address step", async () => {
    await render(<ConnectScreen />);
    expect(screen.getByText("TomeSonic")).toBeTruthy();
    expect(screen.getByText("Server address")).toBeTruthy();
    expect(screen.getByText("Submit")).toBeTruthy();
    expect(screen.getByText(/does not provide any content/)).toBeTruthy();
  });

  it("validates an empty address without hitting the network", async () => {
    await render(<ConnectScreen />);
    await fireEvent.press(screen.getByText("Submit"));
    await screen.findByText("Please enter a server address");
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("tries https:// first for a bare hostname and advances without a cleartext warning", async () => {
    mockedGet.mockResolvedValue(absStatus());
    await render(<ConnectScreen />);
    await connect("abs.example.com");

    await screen.findByPlaceholderText("Username");
    // https-first: most ABS deployments sit behind TLS, and defaulting to
    // http:// sent credentials in the clear when the server answered on both.
    expect(mockedGet).toHaveBeenCalledWith("https://abs.example.com/status", { timeout: 10000 });
    expect(screen.getByText("abs.example.com", { exact: false })).toBeTruthy();
    expect(screen.getByPlaceholderText("Password")).toBeTruthy();
    expect(screen.queryByText(/unencrypted HTTP/)).toBeNull();
  });

  it("falls back to http:// when https is unreachable, with a cleartext warning", async () => {
    mockedGet.mockImplementation((url: string) =>
      url.startsWith("https://")
        ? Promise.reject(new Error("ECONNREFUSED"))
        : Promise.resolve(absStatus())
    );
    await render(<ConnectScreen />);
    await connect("abs.example.com");

    await screen.findByPlaceholderText("Username");
    expect(mockedGet).toHaveBeenCalledWith("https://abs.example.com/status", { timeout: 10000 });
    expect(mockedGet).toHaveBeenCalledWith("http://abs.example.com/status", { timeout: 10000 });
    // Plain-http server → unencrypted-connection warning.
    expect(screen.getByText(/unencrypted HTTP/)).toBeTruthy();
  });

  it("respects an explicit http:// scheme without probing https", async () => {
    mockedGet.mockResolvedValue(absStatus());
    await render(<ConnectScreen />);
    await connect("http://abs.example.com");

    await screen.findByPlaceholderText("Username");
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith("http://abs.example.com/status", { timeout: 10000 });
    expect(screen.getByText(/unencrypted HTTP/)).toBeTruthy();
  });

  it("rejects a server that is not Audiobookshelf", async () => {
    mockedGet.mockResolvedValue({ data: { app: "something-else" } });
    await render(<ConnectScreen />);
    await connect();
    await screen.findByText("This does not appear to be an Audiobookshelf server.");
    expect(screen.queryByPlaceholderText("Username")).toBeNull();
  });

  it("surfaces unreachable-server errors", async () => {
    mockedGet.mockRejectedValue(new Error("ECONNREFUSED"));
    await render(<ConnectScreen />);
    await connect();
    await screen.findByText("Unable to connect to the server. Please verify the URL.");
  });

  it("names a certificate problem when the TLS handshake is the definitive failure", async () => {
    // Explicit https:// → a single candidate. The handshake fails on an
    // untrusted cert and there is NO connection-level refusal, so the cert
    // problem is unambiguously the cause.
    mockedGet.mockRejectedValue(
      new Error(
        "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found."
      )
    );
    await render(<ConnectScreen />);
    await connect("https://abs.example.com");
    // Not the generic "verify the URL" — a certificate-specific message.
    await screen.findByText(/security certificate/);
    expect(screen.queryByPlaceholderText("Username")).toBeNull();
  });

  it("SE#5: bare host with https→TLS error then http→refused prefers a 'couldn't reach' message, not cert-install advice", async () => {
    // Candidates for a bare host are [https://host, http://host]. https fails
    // the handshake (untrusted cert) but http is REFUSED — the server may be
    // down or only reachable over http, so blaming the certificate would send
    // the user chasing the wrong fix.
    mockedGet.mockImplementation((url: string) =>
      url.startsWith("https://")
        ? Promise.reject(
            new Error(
              "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found."
            )
          )
        : Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:80"))
    );
    await render(<ConnectScreen />);
    await connect("abs.example.com");

    // A reachability-focused message...
    await screen.findByText(/Couldn't reach the server/);
    // ...and specifically NOT the cert-install instruction.
    expect(screen.queryByText(/security certificate/)).toBeNull();
    expect(screen.queryByText(/install it in Android settings/)).toBeNull();
    expect(screen.queryByPlaceholderText("Username")).toBeNull();
  });

  it("requires username and password before logging in", async () => {
    mockedGet.mockResolvedValue(absStatus());
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.press(screen.getByText("Submit"));
    await screen.findByText("Please enter username and password");
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("logs in with local credentials and hands the session to the user store", async () => {
    mockedGet.mockResolvedValue(absStatus());
    mockedPost.mockResolvedValue({
      data: {
        user: { id: "u1", username: "bob", token: "tok123", refreshToken: "ref456", mediaProgress: [] },
      },
    });
    const login = jest.fn();
    useUserStore.setState({ login } as any);
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.changeText(screen.getByPlaceholderText("Username"), "bob");
    await fireEvent.changeText(screen.getByPlaceholderText("Password"), "hunter2");
    await fireEvent.press(screen.getByText("Submit"));

    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith(
        "https://abs.example.com/login",
        { username: "bob", password: "hunter2" },
        expect.objectContaining({ timeout: 15000 })
      )
    );
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "https://abs.example.com",
          userId: "u1",
          username: "bob",
          token: "tok123",
          refreshToken: "ref456",
          name: "abs.example.com",
          // The server version probed at connect time is persisted on the
          // config so the Account screen's "Server version" line can render it.
          version: "2.17.0",
        }),
        expect.objectContaining({ id: "u1", username: "bob" })
      )
    );
  });

  it("shows a specific error for 401 credentials", async () => {
    mockedGet.mockResolvedValue(absStatus());
    mockedPost.mockRejectedValue({ response: { status: 401 } });
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.changeText(screen.getByPlaceholderText("Username"), "bob");
    await fireEvent.changeText(screen.getByPlaceholderText("Password"), "wrong");
    await fireEvent.press(screen.getByText("Submit"));
    await screen.findByText("Invalid username or password.");
  });

  it("treats a 403 like a credentials rejection", async () => {
    mockedGet.mockResolvedValue(absStatus());
    mockedPost.mockRejectedValue({ response: { status: 403 } });
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.changeText(screen.getByPlaceholderText("Username"), "bob");
    await fireEvent.changeText(screen.getByPlaceholderText("Password"), "wrong");
    await fireEvent.press(screen.getByText("Submit"));
    await screen.findByText("Invalid username or password.");
  });

  it("distinguishes a network/timeout failure from bad credentials", async () => {
    mockedGet.mockResolvedValue(absStatus());
    // Axios timeout / connection error carries no `response`.
    mockedPost.mockRejectedValue(new Error("timeout of 15000ms exceeded"));
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.changeText(screen.getByPlaceholderText("Username"), "bob");
    await fireEvent.changeText(screen.getByPlaceholderText("Password"), "hunter2");
    await fireEvent.press(screen.getByText("Submit"));
    await screen.findByText("Couldn't reach the server. Check the address and your connection.");
  });

  it("distinguishes a 5xx server error from bad credentials", async () => {
    mockedGet.mockResolvedValue(absStatus());
    mockedPost.mockRejectedValue({ response: { status: 502 } });
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.changeText(screen.getByPlaceholderText("Username"), "bob");
    await fireEvent.changeText(screen.getByPlaceholderText("Password"), "hunter2");
    await fireEvent.press(screen.getByText("Submit"));
    await screen.findByText("The server had a problem. Please try again.");
  });

  it("distinguishes a 429 rate limit from bad credentials", async () => {
    mockedGet.mockResolvedValue(absStatus());
    mockedPost.mockRejectedValue({ response: { status: 429 } });
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.changeText(screen.getByPlaceholderText("Username"), "bob");
    await fireEvent.changeText(screen.getByPlaceholderText("Password"), "hunter2");
    await fireEvent.press(screen.getByText("Submit"));
    await screen.findByText("Too many attempts. Please wait a moment and try again.");
  });

  it("OpenID-only server hides local fields and runs the OAuth flow", async () => {
    mockedGet.mockResolvedValue(
      absStatus({ authMethods: ["openid"], authFormData: { authOpenIDButtonText: "SSO Login" } })
    );
    mockedOpenId.mockResolvedValue({ id: "u2", username: "sso-user", accessToken: "at1" });
    const login = jest.fn();
    useUserStore.setState({ login } as any);
    await render(<ConnectScreen />);
    await connect();

    const ssoButton = await screen.findByText("SSO Login");
    expect(screen.queryByPlaceholderText("Username")).toBeNull();

    await fireEvent.press(ssoButton);
    await waitFor(() => expect(mockedOpenId).toHaveBeenCalledWith("https://abs.example.com"));
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({ token: "at1", userId: "u2", username: "sso-user" }),
        expect.objectContaining({ id: "u2" })
      )
    );
  });

  it("edit-address returns to step 1", async () => {
    mockedGet.mockResolvedValue(absStatus());
    await render(<ConnectScreen />);
    await connect();
    await screen.findByPlaceholderText("Username");

    await fireEvent.press(screen.getByLabelText("Change server address"));
    expect(screen.getByPlaceholderText("http://55.55.55.55:13378")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Username")).toBeNull();
  });

  describe("PO#2 — saved-server memory", () => {
    it("prefills the LAST-used saved server's address after a switch (config is null)", async () => {
      storage.set(
        "savedServers",
        JSON.stringify([
          { address: "https://one.example.com", username: "alice", authMethod: "local" },
          { address: "https://two.example.com", username: "bob", authMethod: "local" },
        ])
      );
      await render(<ConnectScreen />);
      // No active config after a switch → the most-recent saved address seeds
      // the field so the user doesn't retype the whole URL.
      const input = screen.getByPlaceholderText("http://55.55.55.55:13378");
      expect(input.props.value).toBe("https://one.example.com");
    });

    it("tapping a saved-server chip prefills the address (and username) fields", async () => {
      storage.set(
        "savedServers",
        JSON.stringify([
          { address: "https://one.example.com", username: "alice", authMethod: "local" },
          { address: "https://two.example.com", username: "bob", authMethod: "local" },
        ])
      );
      mockedGet.mockResolvedValue(absStatus());
      await render(<ConnectScreen />);

      const input = screen.getByPlaceholderText("http://55.55.55.55:13378");
      // Tap the SECOND chip — it should overwrite the seeded first address.
      await fireEvent.press(screen.getByLabelText("Use saved server two.example.com"));
      expect(input.props.value).toBe("https://two.example.com");

      // The prefilled username carries through to the credentials step.
      await fireEvent.press(screen.getByText("Submit"));
      await screen.findByPlaceholderText("Username");
      expect(screen.getByPlaceholderText("Username").props.value).toBe("bob");
    });

    it("gives saved-server chips a hitSlop so the ~34dp chip stays tappable", async () => {
      storage.set(
        "savedServers",
        JSON.stringify([
          { address: "https://one.example.com", username: "alice", authMethod: "local" },
        ])
      );
      await render(<ConnectScreen />);

      const chip = screen.getByLabelText("Use saved server one.example.com");
      // Matches the FilterChip/tab-pill treatment: extend the touch target
      // vertically since the chip itself is under the 48dp minimum.
      expect(chip.props.hitSlop).toEqual({ top: 8, bottom: 8 });
    });

    it("persists the server (address/username/method, NO secrets) after a successful login", async () => {
      mockedGet.mockResolvedValue(absStatus());
      mockedPost.mockResolvedValue({
        data: { user: { id: "u1", username: "bob", token: "tok123", refreshToken: "ref456" } },
      });
      const login = jest.fn();
      useUserStore.setState({ login } as any);
      await render(<ConnectScreen />);
      await connect("abs.example.com");
      await screen.findByPlaceholderText("Username");

      await fireEvent.changeText(screen.getByPlaceholderText("Username"), "bob");
      await fireEvent.changeText(screen.getByPlaceholderText("Password"), "hunter2");
      await fireEvent.press(screen.getByText("Submit"));

      await waitFor(() => expect(login).toHaveBeenCalled());

      const saved = JSON.parse(storage.getString("savedServers")!);
      expect(saved[0]).toMatchObject({
        address: "https://abs.example.com",
        username: "bob",
        authMethod: "local",
      });
      // Never persist secrets.
      const serialized = storage.getString("savedServers")!;
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("tok123");
      expect(serialized).not.toContain("ref456");
    });
  });
});
