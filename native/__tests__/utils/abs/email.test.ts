/**
 * utils/abs/email — exact method+path+payload triples (verified against the
 * ABS v2.35.1 ApiRouter/EmailController) and the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import {
  getEmailSettings,
  updateEmailSettings,
  sendTestEmail,
  updateAdminEreaderDevices,
} from "../../../utils/abs/email";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
});

it("getEmailSettings → GET /api/emails/settings, unwraps { settings }", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ settings: { host: "smtp.x.com", port: 465 } }));
  await expect(getEmailSettings()).resolves.toEqual({ host: "smtp.x.com", port: 465 });
  expect(api.get).toHaveBeenCalledWith("/api/emails/settings");
});

it("updateEmailSettings → PATCH /api/emails/settings, unwraps { settings }", async () => {
  jest.mocked(api.patch).mockResolvedValue(ok({ settings: { host: "smtp.y.com" } }));
  await expect(updateEmailSettings({ host: "smtp.y.com" })).resolves.toEqual({
    host: "smtp.y.com",
  });
  expect(api.patch).toHaveBeenCalledWith("/api/emails/settings", { host: "smtp.y.com" });
});

it("sendTestEmail → POST /api/emails/test", async () => {
  await sendTestEmail();
  expect(api.post).toHaveBeenCalledWith("/api/emails/test");
});

it("updateAdminEreaderDevices → POST /api/emails/ereader-devices { ereaderDevices }", async () => {
  const devices = [{ name: "Kindle", email: "k@kindle.com" }];
  jest.mocked(api.post).mockResolvedValue(ok({ ereaderDevices: devices }));
  await expect(updateAdminEreaderDevices(devices)).resolves.toEqual(devices);
  expect(api.post).toHaveBeenCalledWith("/api/emails/ereader-devices", {
    ereaderDevices: devices,
  });
});

describe("error normalization", () => {
  it("non-admin (adminMiddleware 403) → forbidden AbsError", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 403 } });
    const err = await getEmailSettings().catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("forbidden");
  });

  it("device-validation 400 keeps the server's reason text", async () => {
    jest.mocked(api.post).mockRejectedValue({
      response: { status: 400, data: "Invalid payload. ereaderDevices array required" },
    });
    await expect(updateAdminEreaderDevices([])).rejects.toMatchObject({
      message: "Invalid payload. ereaderDevices array required",
    });
  });

  it("offline → offline AbsError", async () => {
    jest.mocked(api.post).mockRejectedValue(new Error("Network Error"));
    await expect(sendTestEmail()).rejects.toMatchObject({ kind: "offline" });
  });
});
