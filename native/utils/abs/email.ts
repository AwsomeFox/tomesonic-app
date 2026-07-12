/**
 * Email / e-reader-device administration. Endpoints verified against the ABS
 * v2.35.1 ApiRouter/EmailController (all behind adminMiddleware):
 *   GET    /api/emails/settings          → { settings }
 *   PATCH  /api/emails/settings          → { settings }
 *   POST   /api/emails/test              (sends to the settings' test address)
 *   POST   /api/emails/ereader-devices   { ereaderDevices } → { ereaderDevices }
 *
 * (The USER-scoped device list lives in utils/abs/me.ts →
 * updateMyEreaderDevices, which hits POST /api/me/ereader-devices instead.)
 *
 * All functions THROW AbsError (see utils/abs/errors.ts).
 */
import { api } from "../api";
import { absRequest } from "./errors";
import type { AbsEmailSettings, AbsEreaderDevice } from "./types";

export async function getEmailSettings(): Promise<AbsEmailSettings> {
  const data = await absRequest<any>(() => api.get("/api/emails/settings"));
  return data?.settings ?? data;
}

export async function updateEmailSettings(
  update: Partial<AbsEmailSettings>
): Promise<AbsEmailSettings> {
  const data = await absRequest<any>(() => api.patch("/api/emails/settings", update));
  return data?.settings ?? data;
}

/** Send a test email (recipient comes from the saved settings). */
export async function sendTestEmail(): Promise<void> {
  await absRequest(() => api.post("/api/emails/test"));
}

/**
 * Replace the server-wide e-reader device list (admin form — for a user
 * editing only their OWN devices, use me.updateMyEreaderDevices).
 */
export async function updateAdminEreaderDevices(
  devices: AbsEreaderDevice[]
): Promise<AbsEreaderDevice[]> {
  const data = await absRequest<any>(() =>
    api.post("/api/emails/ereader-devices", { ereaderDevices: devices })
  );
  return Array.isArray(data?.ereaderDevices) ? data.ereaderDevices : devices;
}
