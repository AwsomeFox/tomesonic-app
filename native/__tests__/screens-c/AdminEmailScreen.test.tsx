/**
 * AdminEmailScreen — SMTP settings form (minimal-diff PATCH), send-test-email
 * action, and server-wide e-reader device CRUD.
 *
 * SECURITY-CRITICAL assertions: the stored SMTP password is never echoed into
 * the form, and a blank pass field keeps the existing password (no `pass` key
 * in the PATCH).
 */
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));

import React from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import AdminEmailScreen from "../../screens/AdminEmailScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { useSnackbarStore } from "../../store/useSnackbarStore";

const alertSpy = showAppDialog as jest.Mock;

const KINDLE = { name: "Kindle", email: "k@kindle.com", availabilityOption: "adminAndUp" };

// The server should never return the real pass, but the form must stay safe
// even if it does (older servers echo the stored value).
const SETTINGS = {
  id: "email-settings",
  host: "smtp.example.com",
  port: 465,
  secure: true,
  user: "mailer",
  pass: "super-secret-pass",
  fromAddress: "abs@example.com",
  testAddress: "me@example.com",
  ereaderDevices: [KINDLE],
};

function mockGetSettings(settings: any = SETTINGS) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/emails/settings") {
      return Promise.resolve({ data: { settings } });
    }
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  // Capture listeners so tests can emit navigation events (beforeRemove) at
  // the screen, ChapterEditor-suite style.
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const navigation: any = {
    goBack: jest.fn(),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    addListener: jest.fn((event: string, cb: (e: any) => void) => {
      (listeners[event] ||= []).push(cb);
      return jest.fn();
    }),
    emit: (event: string, e: any) => (listeners[event] || []).forEach((cb) => cb(e)),
  };
  return navigation;
}

async function renderLoaded() {
  const navigation = makeNavigation();
  await render(<AdminEmailScreen navigation={navigation} />);
  await screen.findByLabelText("SMTP host");
  return navigation;
}

const snackbarMessage = () => useSnackbarStore.getState().current?.message;

beforeEach(() => {
  useSnackbarStore.setState({ current: null } as any);
});

describe("AdminEmailScreen", () => {
  it("loads the SMTP settings into the form and NEVER echoes the stored password", async () => {
    mockGetSettings();
    await renderLoaded();

    expect(api.get).toHaveBeenCalledWith("/api/emails/settings");
    expect(screen.getByDisplayValue("smtp.example.com")).toBeTruthy();
    expect(screen.getByDisplayValue("465")).toBeTruthy();
    expect(screen.getByDisplayValue("mailer")).toBeTruthy();
    expect(screen.getByDisplayValue("abs@example.com")).toBeTruthy();
    expect(screen.getByDisplayValue("me@example.com")).toBeTruthy();

    // The server returned pass: "super-secret-pass" — it must not appear
    // anywhere in the form; the pass field is empty with leave-blank semantics.
    expect(screen.queryByDisplayValue("super-secret-pass")).toBeNull();
    const passInput = screen.getByLabelText("SMTP password");
    expect(passInput.props.value).toBe("");
    expect(passInput.props.placeholder).toMatch(/leave blank/i);
    expect(passInput.props.secureTextEntry).toBe(true);

    // Server-wide device list rendered.
    expect(screen.getByText("Kindle")).toBeTruthy();
    expect(screen.getByText("k@kindle.com")).toBeTruthy();
  });

  it("uses the borderless field skin and a returnKeyType focus chain ending in done", async () => {
    mockGetSettings();
    await renderLoaded();

    // Borderless skin (matches AdminUserDetail/EditMetadata's Field): fontSize
    // 15 with a transparent border, not the old bordered fontSize-16 outline.
    const hostStyle = StyleSheet.flatten(screen.getByLabelText("SMTP host").props.style);
    expect(hostStyle.fontSize).toBe(15);
    expect(hostStyle.borderColor).toBe("transparent");

    // Focus chain: host → port → user → pass → from → test("done").
    expect(screen.getByLabelText("SMTP host").props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("SMTP port").props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("SMTP username").props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("SMTP password").props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("From address").props.returnKeyType).toBe("next");
    expect(screen.getByLabelText("Test address").props.returnKeyType).toBe("done");

    // Every non-terminal field carries a submit handler that advances the chain.
    for (const label of ["SMTP host", "SMTP port", "SMTP username", "SMTP password", "From address"]) {
      expect(typeof screen.getByLabelText(label).props.onSubmitEditing).toBe("function");
    }
  });

  it("Save is disabled until dirty, then PATCHes ONLY the changed fields — no pass key when blank", async () => {
    mockGetSettings();
    (api.patch as jest.Mock).mockImplementation((_url: string, body: any) =>
      Promise.resolve({ data: { settings: { ...SETTINGS, ...body } } })
    );
    await renderLoaded();

    const save = screen.getByLabelText("Save email settings");
    expect(save.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(save);
    expect(api.patch).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText("SMTP host"), "smtp2.example.com");
    await fireEvent.changeText(screen.getByLabelText("SMTP port"), "587");
    await fireEvent.press(
      screen.getByLabelText("Secure (SSL/TLS), Use an encrypted connection")
    );

    await fireEvent.press(screen.getByLabelText("Save email settings"));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/emails/settings", {
        host: "smtp2.example.com",
        port: 587,
        secure: false,
      })
    );
    // Blank pass field = keep the server's existing password: the payload must
    // not carry a pass key at all (not even null/empty).
    const body = (api.patch as jest.Mock).mock.calls[0][1];
    expect(Object.prototype.hasOwnProperty.call(body, "pass")).toBe(false);
    // Unchanged fields are not resent either (minimal diff).
    expect(Object.prototype.hasOwnProperty.call(body, "user")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "fromAddress")).toBe(false);

    expect(snackbarMessage()).toBe("Email settings saved");
  });

  it("sends a typed password once, then clears it from the form after saving", async () => {
    mockGetSettings();
    // Server echo includes the new pass — the form must still not re-seed it.
    (api.patch as jest.Mock).mockResolvedValue({
      data: { settings: { ...SETTINGS, pass: "newpass" } },
    });
    await renderLoaded();

    await fireEvent.changeText(screen.getByLabelText("SMTP password"), "newpass");
    await fireEvent.press(screen.getByLabelText("Save email settings"));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/emails/settings", { pass: "newpass" })
    );
    await waitFor(() => expect(screen.queryByDisplayValue("newpass")).toBeNull());
    expect(screen.getByLabelText("SMTP password").props.value).toBe("");
    // Form is clean again after the save.
    expect(screen.getByLabelText("Save email settings").props.accessibilityState.disabled).toBe(
      true
    );
  });

  it("rejects a non-numeric port before PATCHing", async () => {
    mockGetSettings();
    await renderLoaded();

    await fireEvent.changeText(screen.getByLabelText("SMTP port"), "not-a-port");
    await fireEvent.press(screen.getByLabelText("Save email settings"));

    expect(alertSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Invalid port" }));
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("sends a test email via POST /api/emails/test — blocked while the form is dirty", async () => {
    mockGetSettings();
    (api.post as jest.Mock).mockResolvedValue({ data: {} });
    await renderLoaded();

    // Dirty form: the test would run against the wrong (saved) settings.
    await fireEvent.changeText(screen.getByLabelText("SMTP host"), "other.example.com");
    await fireEvent.press(screen.getByText("Send test email"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Save your changes first" })
    );
    expect(api.post).not.toHaveBeenCalled();

    // Clean form: fires the POST and confirms with a snackbar.
    await fireEvent.changeText(screen.getByLabelText("SMTP host"), "smtp.example.com");
    await fireEvent.press(screen.getByText("Send test email"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/emails/test"));
    await waitFor(() => expect(snackbarMessage()).toBe("Test email sent"));
  });

  it("surfaces a test-email failure as a dialog", async () => {
    mockGetSettings();
    (api.post as jest.Mock).mockRejectedValue({
      response: { status: 500, data: "SMTP connect failed" },
    });
    await renderLoaded();

    await fireEvent.press(screen.getByText("Send test email"));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Test email failed", message: "SMTP connect failed" })
      )
    );
    expect(snackbarMessage()).toBeUndefined();
  });

  it("adds a server-wide e-reader device by POSTing the full replacement list", async () => {
    mockGetSettings();
    (api.post as jest.Mock).mockImplementation((url: string, body: any) => {
      if (url === "/api/emails/ereader-devices") {
        return Promise.resolve({ data: { ereaderDevices: body.ereaderDevices } });
      }
      return Promise.resolve({ data: {} });
    });
    await renderLoaded();

    await fireEvent.press(screen.getByText("Add device"));
    await fireEvent.changeText(screen.getByLabelText("Device name"), "Kobo");
    await fireEvent.changeText(screen.getByLabelText("Device email"), "kobo@example.com");
    await fireEvent.press(screen.getByLabelText("Save device"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/emails/ereader-devices", {
        ereaderDevices: [
          KINDLE,
          { name: "Kobo", email: "kobo@example.com", availabilityOption: "adminAndUp" },
        ],
      })
    );
    // List re-rendered from the server's echo; modal closed.
    await waitFor(() => expect(screen.getByText("Kobo")).toBeTruthy());
    expect(screen.queryByLabelText("Device name")).toBeNull();
    expect(snackbarMessage()).toBe("Device added");
  });

  it("validates device name/email and duplicate names before posting, with specific dialog titles", async () => {
    mockGetSettings();
    await renderLoaded();

    // Nothing entered → the missing NAME is called out first (not a generic
    // "Error").
    await fireEvent.press(screen.getByText("Add device"));
    await fireEvent.press(screen.getByLabelText("Save device"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Device name required" })
    );

    // Name present but no usable email.
    await fireEvent.changeText(screen.getByLabelText("Device name"), "Kobo");
    await fireEvent.press(screen.getByLabelText("Save device"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Valid email required",
        message: expect.stringMatching(/valid email/i),
      })
    );

    // Duplicate of the existing "Kindle" device (case-insensitive).
    await fireEvent.changeText(screen.getByLabelText("Device name"), "kindle");
    await fireEvent.changeText(screen.getByLabelText("Device email"), "x@kindle.com");
    await fireEvent.press(screen.getByLabelText("Save device"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Device name already used",
        message: expect.stringMatching(/already exists/i),
      })
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it("removes a device only after the confirm dialog's destructive action", async () => {
    mockGetSettings();
    (api.post as jest.Mock).mockImplementation((url: string, body: any) => {
      if (url === "/api/emails/ereader-devices") {
        return Promise.resolve({ data: { ereaderDevices: body.ereaderDevices } });
      }
      return Promise.resolve({ data: {} });
    });
    await renderLoaded();

    await fireEvent.press(screen.getByLabelText("Remove Kindle"));
    // Nothing sent until the dialog is confirmed.
    expect(api.post).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove "Kindle"?', buttons: expect.any(Array) })
    );

    const buttons = alertSpy.mock.calls[0][0].buttons;
    expect(buttons.find((b: any) => b.text === "Cancel")).toBeTruthy();
    const removeBtn = buttons.find((b: any) => b.text === "Remove");
    expect(removeBtn.style).toBe("destructive");

    await act(async () => {
      await removeBtn.onPress();
    });
    expect(api.post).toHaveBeenCalledWith("/api/emails/ereader-devices", { ereaderDevices: [] });
    await waitFor(() => expect(screen.queryByText("Kindle")).toBeNull());
    expect(snackbarMessage()).toBe("Device removed");
  });

  it("shows the offline error state when the load never reaches the server, and retries", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("Network Error")); // no .response = offline
    await render(<AdminEmailScreen navigation={makeNavigation()} />);

    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.getByText("Server administration needs a connection.")).toBeTruthy();

    mockGetSettings();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByLabelText("SMTP host")).toBeTruthy();
  });

  it("shows the admin-access error state on a 403", async () => {
    (api.get as jest.Mock).mockRejectedValue({ response: { status: 403, data: "" } });
    await render(<AdminEmailScreen navigation={makeNavigation()} />);

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByLabelText("SMTP host")).toBeNull();
  });

  it("keeps the form (and its values) when a save fails, surfacing the server message", async () => {
    mockGetSettings();
    (api.patch as jest.Mock).mockRejectedValue({
      response: { status: 500, data: "Invalid SMTP config" },
    });
    await renderLoaded();

    await fireEvent.changeText(screen.getByLabelText("SMTP host"), "smtp2.example.com");
    await fireEvent.press(screen.getByLabelText("Save email settings"));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't save email settings",
          message: "Invalid SMTP config",
        })
      )
    );
    // Edits preserved for another attempt.
    expect(screen.getByDisplayValue("smtp2.example.com")).toBeTruthy();
    expect(snackbarMessage()).toBeUndefined();
  });

  describe("unsaved-changes guard (beforeRemove)", () => {
    it("intercepts leaving with a dirty form; Discard proceeds with the blocked action", async () => {
      mockGetSettings();
      const navigation = await renderLoaded();

      await fireEvent.changeText(screen.getByLabelText("SMTP host"), "smtp2.example.com");

      const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
      await act(async () => {
        navigation.emit("beforeRemove", event);
      });

      // Navigation blocked + discard confirm shown.
      expect(event.preventDefault).toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Discard email changes?" })
      );

      const dialog = alertSpy.mock.calls
        .map((c) => c[0])
        .find((d) => d.title === "Discard email changes?");
      expect(dialog.buttons.find((b: any) => b.text === "Keep editing").style).toBe("cancel");
      const discard = dialog.buttons.find((b: any) => b.text === "Discard");
      expect(discard.style).toBe("destructive");

      discard.onPress();
      expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
    });

    it("lets a clean form leave without interception", async () => {
      mockGetSettings();
      const navigation = await renderLoaded();

      const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
      await act(async () => {
        navigation.emit("beforeRemove", event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Discard email changes?" })
      );
    });
  });

  describe("header + device-modal accessibility", () => {
    it("renders the admin-family header with a header-role title", async () => {
      mockGetSettings();
      await renderLoaded();

      expect(screen.getByRole("header", { name: "Email" })).toBeTruthy();
      expect(screen.getByLabelText("Go back")).toBeTruthy();
    });

    it("device modal announces on open, marks its title as a header, and caps the name in words", async () => {
      const announceSpy = jest
        .spyOn(AccessibilityInfo, "announceForAccessibility")
        .mockImplementation(() => {});
      mockGetSettings();
      await renderLoaded();

      await fireEvent.press(screen.getByText("Add device"));

      // Title carries the header role (screen readers can jump to it).
      expect(screen.getByRole("header", { name: "Add device" })).toBeTruthy();
      // Device names are proper nouns → words autocapitalize.
      expect(screen.getByLabelText("Device name").props.autoCapitalize).toBe("words");
      // Mirrors AppDialog's on-open announce (RN Modal is silent by default).
      await waitFor(() =>
        expect(announceSpy).toHaveBeenCalledWith(expect.stringContaining("Add device"))
      );
    });
  });
});
