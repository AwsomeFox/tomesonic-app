import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";

// Matches the redirect URI the original app registered and that Audiobookshelf
// servers allow-list by default for mobile OIDC.
const REDIRECT_URI = "audiobookshelf://oauth";
const CLIENT_ID = "Audiobookshelf-App";

function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomHex(bytes: number): string {
  const arr = Crypto.getRandomBytes(bytes);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getParam(url: string, key: string): string | null {
  const m = url.match(new RegExp(`[?&#]${key}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// Extract "name=value" pairs from one or more Set-Cookie header values so we can
// forward the session cookie to the callback request.
function extractCookieHeader(headers: Headers): string {
  const anyHeaders = headers as any;
  let cookieStrings: string[] = [];
  if (typeof anyHeaders.getSetCookie === "function") {
    cookieStrings = anyHeaders.getSetCookie();
  } else {
    const combined = headers.get("set-cookie");
    // Split on commas that precede a new "name=" (avoids splitting Expires dates)
    if (combined) cookieStrings = combined.split(/,(?=\s*[^;,\s]+=)/);
  }
  return cookieStrings
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * Audiobookshelf OpenID Connect (OAuth2 + PKCE) login for React Native.
 *
 * ABS's OIDC flow is session-cookie based: `/auth/openid` sets a `connect.sid`
 * cookie that `/auth/openid/callback` requires. So we must:
 *   1. Call `/auth/openid` from the app (expo/fetch, no auto-redirect) to obtain
 *      BOTH the IdP authorize URL (Location header) and the session cookie.
 *   2. Open only the IdP URL in the auth browser for the user to sign in. The IdP
 *      redirects to the server's /auth/openid/mobile-redirect which bounces to
 *      audiobookshelf://oauth?code=...&state=...
 *   3. Exchange the code at `/auth/openid/callback`, forwarding the session cookie.
 */
export async function loginWithOpenId(serverAddress: string): Promise<any | null> {
  const server = serverAddress.replace(/\/$/, "");

  const verifier = randomHex(32);
  const challengeB64 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  const challenge = toBase64Url(challengeB64);

  const initUrl =
    `${server}/auth/openid?response_type=code` +
    `&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256`;

  // 1. Initiate the flow from the app so the session cookie lands in our client.
  console.log("[OAuth] init:", initUrl);
  const initResp = await expoFetch(initUrl, { redirect: "manual" as any });
  const idpUrl = initResp.headers.get("location");
  const cookieHeader = extractCookieHeader(initResp.headers);
  console.log("[OAuth] idpUrl:", idpUrl, "| cookies:", cookieHeader ? "yes" : "none");
  if (!idpUrl) {
    throw new Error("Server did not return an OpenID provider URL.");
  }

  // 2. Open the provider URL for the user to authenticate.
  const result = await WebBrowser.openAuthSessionAsync(idpUrl, REDIRECT_URI, {
    showInRecents: true,
  });
  console.log("[OAuth] browser result:", result.type);
  if (result.type === "cancel" || result.type === "dismiss") return null;
  if (result.type !== "success" || !result.url) {
    throw new Error(`Browser returned '${result.type}' without a redirect URL.`);
  }

  const err = getParam(result.url, "error");
  if (err) throw new Error(`Provider error: ${err}`);
  const code = getParam(result.url, "code");
  const state = getParam(result.url, "state");
  if (!code) throw new Error("No authorization code in the redirect.");

  // 3. Exchange the code, forwarding the session cookie from step 1.
  const callbackUrl =
    `${server}/auth/openid/callback?code=${encodeURIComponent(code)}` +
    `&code_verifier=${encodeURIComponent(verifier)}` +
    (state ? `&state=${encodeURIComponent(state)}` : "");

  console.log("[OAuth] exchanging code...");
  const cbResp = await expoFetch(callbackUrl, {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  if (!cbResp.ok) {
    const body = await cbResp.text().catch(() => "");
    throw new Error(`Callback failed (${cbResp.status}): ${body.slice(0, 120)}`);
  }
  const data = await cbResp.json();
  const user = data?.user;
  if (!user || (!user.accessToken && !user.token)) {
    throw new Error("Callback response did not include a token.");
  }
  console.log("[OAuth] success for", user.username);
  return user;
}
