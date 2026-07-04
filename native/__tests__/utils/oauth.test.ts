import * as WebBrowser from "expo-web-browser";
import { fetch as expoFetch } from "expo/fetch";
import { loginWithOpenId } from "../../utils/oauth";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }), { virtual: true });

// The global expo-crypto mock (jest.setup.ts) doesn't define CryptoEncoding,
// which oauth.ts needs — override file-locally with a base64-ish digest whose
// +, / and = exercise the base64url conversion.
jest.mock("expo-crypto", () => ({
  getRandomBytes: jest.fn((n: number) => new Uint8Array(n).fill(7)),
  digestStringAsync: jest.fn(async () => "ab+/cd=="),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64" },
}));

const mockedFetch = expoFetch as jest.Mock;
const mockedAuthSession = WebBrowser.openAuthSessionAsync as jest.Mock;

// getRandomBytes is mocked to return bytes filled with 7 -> "07" * 32.
const VERIFIER = "07".repeat(32);

const makeHeaders = (map: Record<string, string>, setCookies?: string[]) => ({
  get: (k: string) => map[k.toLowerCase()] ?? null,
  ...(setCookies ? { getSetCookie: () => setCookies } : {}),
});

const initResponse = (setCookies?: string[], location = "https://idp.example/authorize?x=1") => ({
  headers: makeHeaders(location ? { location } : {}, setCookies),
});

const callbackResponse = (user: any, ok = true, status = 200) => ({
  ok,
  status,
  headers: makeHeaders({}),
  json: async () => ({ user }),
  text: async () => "boom body",
});

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockedAuthSession.mockResolvedValue({
    type: "success",
    url: "audiobookshelf://oauth?code=CODE123&state=STATE456",
  });
});

describe("loginWithOpenId", () => {
  it("runs the full PKCE flow and returns the user", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        initResponse([
          "connect.sid=abc123; Path=/; HttpOnly",
          "other=val; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
        ])
      )
      .mockResolvedValueOnce(callbackResponse({ username: "amy", accessToken: "at1" }));

    const user = await loginWithOpenId("http://abs.local/");
    expect(user).toEqual({ username: "amy", accessToken: "at1" });

    // 1. Init request: server-rooted, PKCE params, registered redirect URI.
    const initUrl: string = mockedFetch.mock.calls[0][0];
    expect(initUrl).toContain("http://abs.local/auth/openid?response_type=code");
    expect(initUrl).toContain("client_id=Audiobookshelf-App");
    expect(initUrl).toContain(encodeURIComponent("audiobookshelf://oauth"));
    // "ab+/cd==" digested -> base64url "ab-_cd" (encodeURIComponent-safe).
    expect(initUrl).toContain("code_challenge=ab-_cd");
    expect(initUrl).toContain("code_challenge_method=S256");
    expect(mockedFetch.mock.calls[0][1]).toEqual({ redirect: "manual" });

    // 2. The IdP url (not the server url) opened in the auth browser.
    expect(mockedAuthSession).toHaveBeenCalledWith(
      "https://idp.example/authorize?x=1",
      "audiobookshelf://oauth",
      { showInRecents: true }
    );

    // 3. Code exchange forwards code, verifier, state and the session cookie.
    const cbUrl: string = mockedFetch.mock.calls[1][0];
    expect(cbUrl).toContain("http://abs.local/auth/openid/callback?code=CODE123");
    expect(cbUrl).toContain(`code_verifier=${VERIFIER}`);
    expect(cbUrl).toContain("state=STATE456");
    expect(mockedFetch.mock.calls[1][1]).toEqual({
      headers: { Cookie: "connect.sid=abc123; other=val" },
    });
  });

  it("extracts cookies from a combined set-cookie header (no getSetCookie)", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        headers: makeHeaders({
          location: "https://idp.example/authorize",
          // Comma-joined cookies with a comma inside an Expires date.
          "set-cookie":
            "connect.sid=abc; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT, foo=bar; Path=/",
        }),
      })
      .mockResolvedValueOnce(callbackResponse({ username: "u", token: "legacy-token" }));

    const user = await loginWithOpenId("http://abs.local");
    expect(user).toEqual({ username: "u", token: "legacy-token" });
    expect(mockedFetch.mock.calls[1][1]).toEqual({
      headers: { Cookie: "connect.sid=abc; foo=bar" },
    });
  });

  it("sends no Cookie header when the server set none", async () => {
    mockedFetch
      .mockResolvedValueOnce(initResponse(undefined))
      .mockResolvedValueOnce(callbackResponse({ username: "u", accessToken: "a" }));
    await loginWithOpenId("http://abs.local");
    expect(mockedFetch.mock.calls[1][1]).toEqual({ headers: {} });
  });

  it("throws when the server returns no provider URL", async () => {
    mockedFetch.mockResolvedValueOnce({ headers: makeHeaders({}) });
    await expect(loginWithOpenId("http://abs.local")).rejects.toThrow(
      "Server did not return an OpenID provider URL."
    );
    expect(mockedAuthSession).not.toHaveBeenCalled();
  });

  it("returns null when the user cancels or dismisses the browser", async () => {
    mockedFetch.mockResolvedValue(initResponse(["connect.sid=x"]));
    mockedAuthSession.mockResolvedValueOnce({ type: "cancel" });
    expect(await loginWithOpenId("http://abs.local")).toBeNull();

    mockedAuthSession.mockResolvedValueOnce({ type: "dismiss" });
    expect(await loginWithOpenId("http://abs.local")).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(2); // never reached the exchange
  });

  it("throws on an unexpected browser result", async () => {
    mockedFetch.mockResolvedValueOnce(initResponse(["connect.sid=x"]));
    mockedAuthSession.mockResolvedValueOnce({ type: "locked" });
    await expect(loginWithOpenId("http://abs.local")).rejects.toThrow(
      "Browser returned 'locked' without a redirect URL."
    );
  });

  it("rejects a redirect outside the registered scheme (never trusts foreign codes)", async () => {
    mockedFetch.mockResolvedValueOnce(initResponse(["connect.sid=x"]));
    mockedAuthSession.mockResolvedValueOnce({
      type: "success",
      url: "https://evil.example/?code=stolen",
    });
    await expect(loginWithOpenId("http://abs.local")).rejects.toThrow(
      "Unexpected redirect URL from the auth session."
    );
  });

  it("surfaces a provider error from the redirect", async () => {
    mockedFetch.mockResolvedValueOnce(initResponse(["connect.sid=x"]));
    mockedAuthSession.mockResolvedValueOnce({
      type: "success",
      url: "audiobookshelf://oauth?error=access_denied",
    });
    await expect(loginWithOpenId("http://abs.local")).rejects.toThrow(
      "Provider error: access_denied"
    );
  });

  it("throws when the redirect carries no code", async () => {
    mockedFetch.mockResolvedValueOnce(initResponse(["connect.sid=x"]));
    mockedAuthSession.mockResolvedValueOnce({
      type: "success",
      url: "audiobookshelf://oauth?state=only",
    });
    await expect(loginWithOpenId("http://abs.local")).rejects.toThrow(
      "No authorization code in the redirect."
    );
  });

  it("throws with status and body snippet when the code exchange fails", async () => {
    mockedFetch
      .mockResolvedValueOnce(initResponse(["connect.sid=x"]))
      .mockResolvedValueOnce(callbackResponse(null, false, 500));
    await expect(loginWithOpenId("http://abs.local")).rejects.toThrow(
      "Callback failed (500): boom body"
    );
  });

  it("throws when the callback response has no token", async () => {
    mockedFetch
      .mockResolvedValueOnce(initResponse(["connect.sid=x"]))
      .mockResolvedValueOnce(callbackResponse({ username: "tokenless" }));
    await expect(loginWithOpenId("http://abs.local")).rejects.toThrow(
      "Callback response did not include a token."
    );
  });

  it("omits state from the exchange when the redirect has none", async () => {
    mockedFetch
      .mockResolvedValueOnce(initResponse(["connect.sid=x"]))
      .mockResolvedValueOnce(callbackResponse({ username: "u", accessToken: "a" }));
    mockedAuthSession.mockResolvedValueOnce({
      type: "success",
      url: "audiobookshelf://oauth?code=CODE123",
    });
    await loginWithOpenId("http://abs.local");
    expect(mockedFetch.mock.calls[1][0]).not.toContain("state=");
  });
});
