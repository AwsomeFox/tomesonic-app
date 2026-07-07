/**
 * ReaderScreen — the WebView is a plain captured element, so these tests
 * cover the LOGIC around it: ebook load pipeline (download → inline HTML),
 * onWebMessage location handling (MMKV cfi + timestamps + ebook-fields-only
 * store update), the debounced ebook-only progress PATCH with one-way
 * isFinished at >=0.99, offline queueing via progressSync, cfi restore
 * freshness (server lastUpdate vs local `_at`), TOC + reading settings
 * modals, PDF page persistence, and the fallback/share paths.
 */
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
jest.mock("react-native-reanimated", () => {
  const RN = require("react-native");
  const chainable = () => {
    const o: any = {};
    [
      "delay", "duration", "springify", "damping", "stiffness", "mass",
      "easing", "build", "withInitialValues", "randomDelay", "reduceMotion",
      "withCallback",
    ].forEach((k) => (o[k] = () => o));
    return o;
  };
  const id = (v: any) => v;
  const easing = (t: number) => t;
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (C: any) => C,
      View: RN.View, Text: RN.Text, Image: RN.Image,
      ScrollView: RN.ScrollView, FlatList: RN.FlatList,
    },
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: any) => ({ value: typeof fn === "function" ? fn() : fn }),
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => {},
    useAnimatedReaction: () => {},
    useReducedMotion: () => false,
    withTiming: id, withSpring: id, withDelay: (_d: any, v: any) => v,
    withRepeat: id, withSequence: id,
    cancelAnimation: () => {},
    interpolate: () => 0,
    interpolateColor: () => "rgb(0, 0, 0)",
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    Extrapolate: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    runOnJS: (fn: any) => fn, runOnUI: (fn: any) => fn,
    Easing: {
      linear: easing, ease: easing, quad: easing, cubic: easing,
      bezier: () => ({ factory: () => easing }),
      in: (f: any) => f || easing, out: (f: any) => f || easing, inOut: (f: any) => f || easing,
    },
    FadeIn: chainable(), FadeOut: chainable(), FadeInDown: chainable(),
    FadeInUp: chainable(), FadeInRight: chainable(), FadeInLeft: chainable(),
    FadeOutDown: chainable(), FadeOutUp: chainable(),
    SlideInDown: chainable(), SlideOutDown: chainable(),
    LinearTransition: chainable(),
    ReduceMotion: { System: "system", Always: "always", Never: "never" },
  };
});
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/progressSync", () => ({
  queueEbookProgressPatch: jest.fn(),
}));
// Capture the rendered WebView/Pdf props so tests can drive onMessage /
// onPageChanged directly (RNTL v14 has no UNSAFE_getByType on `screen`).
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
jest.mock(
  "react-native-pdf",
  () => {
    const React = require("react");
    return {
      __esModule: true,
      default: (props: any) => {
        (global as any).__pdfProps = props;
        return React.createElement("Pdf", props);
      },
    };
  },
  { virtual: true }
);

import React from "react";
import { Linking } from "react-native";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import * as FileSystem from "expo-file-system/legacy";
import ReaderScreen from "../../screens/ReaderScreen";
import { api } from "../../utils/api";
import { queueEbookProgressPatch } from "../../utils/progressSync";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { storage, storageHelper, secureStorage } from "../../utils/storage";

const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialDownload = useDownloadStore.getState();

const ITEM = "item1";
const EBOOK_URI = `https://abs.example.com/api/items/${ITEM}/ebook?token=tok`;

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderReader(params: any = { itemId: ITEM, ebookFormat: "epub", title: "My Book" }) {
  const navigation = makeNavigation();
  const utils = await render(<ReaderScreen navigation={navigation} route={{ params }} />);
  return { navigation, unmount: utils.unmount };
}

async function readyWebView(): Promise<any> {
  await waitFor(() => expect((global as any).__webViewProps).toBeTruthy());
  return (global as any).__webViewProps;
}

function sendLocation(webProps: any, payload: any) {
  webProps.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
}

const LOCATION = {
  type: "location",
  cfi: "epubcfi(/6/8!/4/2)",
  fraction: 0.42,
  page: 10,
  pages: 100,
  tocItem: { label: "Chapter 1" },
};

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  useDownloadStore.setState(initialDownload, true);
  usePlaybackStore.setState({ currentSession: null } as any);
  useDownloadStore.setState({ completedDownloads: {} } as any);
  storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
  storage.getAllKeys().forEach((k) => storage.remove(k));
  (global as any).__webViewProps = null;
  (global as any).__pdfProps = null;
  (api.patch as jest.Mock).mockResolvedValue({ data: {} });
  // clearMocks resets call data but keeps implementations; individual tests
  // override these, so re-pin the defaults from jest.setup.ts every time.
  jest.mocked(FileSystem.downloadAsync).mockResolvedValue({ uri: "file:///test-cache/dl", status: 200 } as any);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({ exists: false } as any);
  jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("");
  jest.mocked(FileSystem.writeAsStringAsync).mockResolvedValue(undefined as any);
  jest.mocked(FileSystem.deleteAsync).mockResolvedValue(undefined as any);
});

afterEach(() => {
  jest.useRealTimers();
  secureStorage.remove("serverConfig");
});

describe("ReaderScreen (epub pipeline)", () => {
  it("downloads the ebook, writes the foliate HTML, and mounts the WebView", async () => {
    await renderReader();
    const webProps = await readyWebView();

    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(
      EBOOK_URI,
      expect.stringContaining(`reader_${ITEM}.epub`),
      { headers: { Authorization: "Bearer tok" } }
    );
    const writeCall = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0];
    expect(writeCall[0]).toContain(`reader_${ITEM}.html`);
    expect(writeCall[1]).toContain("foliate-js");
    expect(webProps.source.uri).toBe(writeCall[0]);
    // Opening the reader records the last interaction as "read".
    expect(storage.getString(`last_interaction_${ITEM}`)).toBe("read");
    // Header shows title + reader controls once ready.
    expect(screen.getByText("My Book")).toBeTruthy();
    expect(screen.getByLabelText("Table of contents")).toBeTruthy();
    expect(screen.getByLabelText("Reading settings")).toBeTruthy();
  });

  it("prefers a local offline download and never deletes it", async () => {
    useDownloadStore.setState({
      completedDownloads: {
        [ITEM]: { parts: [{ id: "ebook", localFilePath: "file:///dl/book.epub" }] },
      },
    } as any);
    await renderReader();
    await readyWebView();

    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith(
      "file:///dl/book.epub",
      expect.objectContaining({ encoding: "base64" })
    );
    // Ignore auto_downloads.json mirror bookkeeping (atomic-write pre-delete);
    // the DOWNLOADED BOOK FILE must never be deleted.
    const fileDeletes = (FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      (c) => !String(c[0]).includes("auto_downloads")
    );
    expect(fileDeletes).toHaveLength(0);
  });

  it("location messages persist the cfi + save timestamp and only touch ebook fields in the store", async () => {
    // Existing AUDIO progress on the same item must survive untouched.
    useUserStore.setState({
      mediaProgress: {
        [ITEM]: {
          libraryItemId: ITEM,
          progress: 0.25,
          currentTime: 900,
          duration: 3600,
          isFinished: false,
          lastUpdate: 111,
        },
      },
    } as any);
    const before = Date.now();
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, LOCATION);
    });

    // MMKV: cfi + freshness timestamp for the restore comparison.
    expect(storage.getString(`ebookCfi_${ITEM}`)).toBe(LOCATION.cfi);
    expect(storage.getNumber(`ebookCfi_${ITEM}_at`)).toBeGreaterThanOrEqual(before);

    // Store: ebook fields updated, audio fields untouched, no isFinished flip.
    const entry = useUserStore.getState().mediaProgress[ITEM];
    expect(entry.ebookLocation).toBe(LOCATION.cfi);
    expect(entry.ebookProgress).toBe(0.42);
    expect(entry.progress).toBe(0.25);
    expect(entry.currentTime).toBe(900);
    expect(entry.duration).toBe(3600);
    expect(entry.isFinished).toBe(false);

    // Footer reflects the relocation.
    expect(screen.getByText("Chapter 1")).toBeTruthy();
    expect(screen.getByText("Page 10 of 100 (42%)")).toBeTruthy();
  });

  it("clamps the footer percent to 1–99 mid-book and 100 at the finish threshold", async () => {
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, { ...LOCATION, fraction: 0.001, page: 1, tocItem: null });
    });
    expect(screen.getByText("Page 1 of 100 (1%)")).toBeTruthy();

    await act(async () => {
      sendLocation(webProps, { ...LOCATION, fraction: 0.995, page: 100, tocItem: null });
    });
    expect(screen.getByText("Page 100 of 100 (100%)")).toBeTruthy();
  });

  it("debounces the progress PATCH and sends ONLY ebook fields (no isFinished mid-book)", async () => {
    await renderReader();
    const webProps = await readyWebView();
    jest.useFakeTimers();

    await act(async () => {
      sendLocation(webProps, { ...LOCATION, cfi: "epubcfi(first)", fraction: 0.3 });
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    // Second relocation inside the window replaces the pending sync.
    await act(async () => {
      sendLocation(webProps, { ...LOCATION, cfi: "epubcfi(second)", fraction: 0.42 });
    });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });

    expect(api.patch).toHaveBeenCalledTimes(1);
    // Exact payload: ebookLocation + ebookProgress and nothing else — sending
    // `progress`/`isFinished` here would clobber audio progress.
    expect(api.patch).toHaveBeenCalledWith(`/api/me/progress/${ITEM}`, {
      ebookLocation: "epubcfi(second)",
      ebookProgress: 0.42,
    });
  });

  it("adds one-way isFinished:true when the fraction crosses 0.99", async () => {
    await renderReader();
    const webProps = await readyWebView();
    jest.useFakeTimers();

    await act(async () => {
      sendLocation(webProps, { ...LOCATION, fraction: 0.995 });
    });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });

    expect(api.patch).toHaveBeenCalledWith(`/api/me/progress/${ITEM}`, {
      ebookLocation: LOCATION.cfi,
      ebookProgress: 0.995,
      isFinished: true,
    });
  });

  it("queues an ebook-only patch through progressSync when the PATCH fails (offline)", async () => {
    (api.patch as jest.Mock).mockRejectedValue({ response: { status: 0 } });
    await renderReader();
    const webProps = await readyWebView();
    jest.useFakeTimers();

    await act(async () => {
      sendLocation(webProps, LOCATION);
    });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });

    expect(queueEbookProgressPatch).toHaveBeenCalledWith(ITEM, LOCATION.cfi, 0.42, false);

    // Finishing offline queues the one-way isFinished too.
    await act(async () => {
      sendLocation(webProps, { ...LOCATION, cfi: "epubcfi(end)", fraction: 0.999 });
    });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(queueEbookProgressPatch).toHaveBeenCalledWith(ITEM, "epubcfi(end)", 0.999, true);
  });

  it("flushes the latest progress to the server on unmount (ebook fields only)", async () => {
    const { unmount } = await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, LOCATION);
    });
    await act(async () => {
      unmount();
    });

    expect(api.patch).toHaveBeenCalledWith(`/api/me/progress/${ITEM}`, {
      ebookLocation: LOCATION.cfi,
      ebookProgress: 0.42,
    });
  });

  it("queues the unmount flush when the server is unreachable", async () => {
    (api.patch as jest.Mock).mockRejectedValue(new Error("offline"));
    const { unmount } = await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, LOCATION);
    });
    await act(async () => {
      unmount();
    });

    expect(queueEbookProgressPatch).toHaveBeenCalledWith(ITEM, LOCATION.cfi, 0.42, false);
  });

  it("restores the SERVER cfi when its lastUpdate is fresher than the local save", async () => {
    storage.set(`ebookCfi_${ITEM}`, "epubcfi(LOCAL)");
    storage.set(`ebookCfi_${ITEM}_at`, 2000);
    useUserStore.setState({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, ebookLocation: "epubcfi(SERVER)", lastUpdate: 5000 },
      },
    } as any);

    await renderReader();
    await readyWebView();

    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    expect(html).toContain('"epubcfi(SERVER)"');
    expect(html).not.toContain("epubcfi(LOCAL)");
  });

  it("keeps the LOCAL cfi when it is fresher than the server's", async () => {
    storage.set(`ebookCfi_${ITEM}`, "epubcfi(LOCAL)");
    storage.set(`ebookCfi_${ITEM}_at`, 9000);
    useUserStore.setState({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, ebookLocation: "epubcfi(SERVER)", lastUpdate: 5000 },
      },
    } as any);

    await renderReader();
    await readyWebView();

    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    expect(html).toContain('"epubcfi(LOCAL)"');
    expect(html).not.toContain("epubcfi(SERVER)");
  });

  it("falls back to the server cfi when there is no local save at all", async () => {
    useUserStore.setState({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, ebookLocation: "epubcfi(SERVER)", lastUpdate: 5000 },
      },
    } as any);

    await renderReader();
    await readyWebView();

    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    expect(html).toContain('"epubcfi(SERVER)"');
  });

  it("renders the TOC modal from the toc message, marking the current section", async () => {
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, LOCATION); // current section: "Chapter 1"
      webProps.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: "toc",
            toc: [
              { label: "Intro", href: "#intro" },
              { label: "Chapter 1", href: "#c1", subitems: [{ label: "Part A", href: "#c1a" }] },
            ],
          }),
        },
      });
    });

    await fireEvent.press(screen.getByLabelText("Table of contents"));
    expect(screen.getByText("Table of Contents")).toBeTruthy();
    expect(screen.getByText("Intro")).toBeTruthy();
    expect(screen.getByText("Part A")).toBeTruthy(); // nested subitem
    // The section being read is selected for screen readers.
    expect(
      screen.getByLabelText("Chapter 1").props.accessibilityState?.selected
    ).toBe(true);

    // Selecting a section injects goToHref into the WebView and closes the sheet.
    await fireEvent.press(screen.getByText("Intro"));
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining('window.goToHref && window.goToHref("#intro")')
    );
    // BottomSheet animates its exit — the sheet unmounts when the close
    // animation finishes, not synchronously on the tap.
    await waitFor(() => expect(screen.queryByText("Table of Contents")).toBeNull());
  });

  it("escapes hostile TOC hrefs — the ebook's own nav must not run script in the WebView", async () => {
    await renderReader();
    const webProps = await readyWebView();

    const hostile = '#x");window.ReactNativeWebView.postMessage("pwn");//';
    await act(async () => {
      webProps.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: "toc",
            toc: [{ label: "Evil", href: hostile }, { label: "NoHref" }],
          }),
        },
      });
    });

    await fireEvent.press(screen.getByLabelText("Table of contents"));
    await fireEvent.press(screen.getByText("Evil"));

    // JSON-escaped: the quote can't terminate the string, the payload stays inert.
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining(`window.goToHref && window.goToHref(${JSON.stringify(hostile)})`)
    );

    // A TOC row without an href must not inject at all.
    (global as any).__injectJS.mockClear();
    await fireEvent.press(screen.getByText("NoHref"));
    expect((global as any).__injectJS).not.toHaveBeenCalled();
  });

  it("reading settings persist text size, font family, and line spacing to MMKV", async () => {
    await renderReader();
    await readyWebView();

    await fireEvent.press(screen.getByLabelText("Reading settings"));
    expect(screen.getByText("Reading Settings")).toBeTruthy();

    // Defaults were written on mount.
    expect(storage.getNumber("reader_font_size")).toBe(100);

    await fireEvent.press(screen.getByLabelText("Increase text size"));
    expect(screen.getByText("110%")).toBeTruthy();
    expect(storage.getNumber("reader_font_size")).toBe(110);
    // Style changes are pushed live into the WebView.
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.setReaderStyles")
    );

    await fireEvent.press(screen.getByLabelText("Decrease text size"));
    expect(storage.getNumber("reader_font_size")).toBe(100);

    await fireEvent.press(screen.getByText("Sans-Serif"));
    expect(storage.getString("reader_font_family")).toBe("sans-serif");

    await fireEvent.press(screen.getByLabelText("Wide line spacing"));
    expect(storage.getNumber("reader_line_height")).toBe(1.8);
  });

  it("offers the share fallback when the ebook is too large to inline", async () => {
    jest
      .mocked(FileSystem.getInfoAsync)
      .mockResolvedValue({ exists: true, size: 13 * 1024 * 1024 } as any);
    await renderReader();

    expect(
      await screen.findByText(/too large to display in-app/)
    ).toBeTruthy();
    expect(screen.getByText("Open in another app")).toBeTruthy();
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("shows the retryable error state when the download fails, then recovers", async () => {
    jest.mocked(FileSystem.downloadAsync).mockRejectedValueOnce(new Error("net down"));
    await renderReader();

    expect(await screen.findByText(/Couldn't open this EPUB in-app/)).toBeTruthy();

    await fireEvent.press(screen.getByText("Try again"));
    await readyWebView();
    expect(screen.getByLabelText("Table of contents")).toBeTruthy();
  });

  it("a foliate error message flips the reader into the error state", async () => {
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      webProps.onMessage({
        nativeEvent: { data: JSON.stringify({ type: "error", message: "bad epub" }) },
      });
    });

    expect(await screen.findByText(/Couldn't open this EPUB in-app/)).toBeTruthy();
  });

  it("jumps to the Read-from-here fraction on WebView ready", async () => {
    await renderReader({ itemId: ITEM, ebookFormat: "epub", title: "My Book", initialFraction: 0.42 });
    const webProps = await readyWebView();
    (global as any).__injectJS.mockClear();

    await act(async () => {
      webProps.onMessage({ nativeEvent: { data: JSON.stringify({ type: "ready" }) } });
    });

    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("goToFraction(0.42)")
    );
  });
});

describe("ReaderScreen (pdf)", () => {
  const PDF_ITEM = "item2";

  it("restores the last-read page, tracks page changes, and persists them", async () => {
    storage.set(`pdfPage_${PDF_ITEM}`, 3);
    await renderReader({ itemId: PDF_ITEM, ebookFormat: "pdf", title: "My PDF" });

    await waitFor(() => expect((global as any).__pdfProps).toBeTruthy());
    const pdfProps = (global as any).__pdfProps;
    expect(pdfProps.page).toBe(3);
    expect(pdfProps.source).toEqual({
      uri: `https://abs.example.com/api/items/${PDF_ITEM}/ebook?token=tok`,
      headers: { Authorization: "Bearer tok" },
    });

    await act(async () => {
      pdfProps.onPageChanged(5, 200);
    });
    expect(screen.getByText("Page 5 of 200")).toBeTruthy();
    expect(storage.getNumber(`pdfPage_${PDF_ITEM}`)).toBe(5);
    // PDF progress mirrors into the store and (debounced) the server, like epub.
    expect(useUserStore.getState().mediaProgress[PDF_ITEM]).toMatchObject({
      ebookLocation: "5",
      ebookProgress: 0.025,
    });
  });

  it("flushes the last PDF page to the server on unmount (debounce cancelled)", async () => {
    storage.set(`pdfPage_${PDF_ITEM}`, 1);
    const { unmount } = await renderReader({ itemId: PDF_ITEM, ebookFormat: "pdf", title: "My PDF" });
    await waitFor(() => expect((global as any).__pdfProps).toBeTruthy());

    await act(async () => {
      (global as any).__pdfProps.onPageChanged(120, 200);
    });
    (api.patch as jest.Mock).mockClear();
    // Leave within the 2s debounce window — the scheduled sync is cancelled,
    // so only the unmount flush must reach the server.
    await act(async () => {
      await unmount();
    });
    expect(api.patch).toHaveBeenCalledWith(
      `/api/me/progress/${PDF_ITEM}`,
      expect.objectContaining({ ebookLocation: "120" })
    );
  });

  it("turns PDF pages with the footer buttons (a11y: scroll-only otherwise)", async () => {
    storage.set(`pdfPage_${PDF_ITEM}`, 10);
    await renderReader({ itemId: PDF_ITEM, ebookFormat: "pdf", title: "My PDF" });
    await waitFor(() => expect((global as any).__pdfProps).toBeTruthy());
    // Footer (and its buttons) render once onPageChanged has reported a page.
    await act(async () => {
      (global as any).__pdfProps.onPageChanged(10, 200);
    });

    await fireEvent.press(screen.getByLabelText("Next page"));
    await waitFor(() => expect((global as any).__pdfProps.page).toBe(11));

    await fireEvent.press(screen.getByLabelText("Previous page"));
    await waitFor(() => expect((global as any).__pdfProps.page).toBe(10));
  });

  it("shows a PDF-specific error with retry when the PDF component errors", async () => {
    await renderReader({ itemId: PDF_ITEM, ebookFormat: "pdf", title: "My PDF" });
    await waitFor(() => expect((global as any).__pdfProps).toBeTruthy());

    await act(async () => {
      (global as any).__pdfProps.onError(new Error("corrupt"));
    });

    // A transient PDF failure (network blip mid-stream) must offer a retry,
    // not the terminal "can't be viewed in-app" copy.
    expect(await screen.findByText(/Couldn't open this PDF/)).toBeTruthy();
    (global as any).__pdfProps = null;

    await fireEvent.press(screen.getByText("Try again"));
    // Retry remounts the viewer instead of leaving the dead-end screen up.
    await waitFor(() => expect((global as any).__pdfProps).toBeTruthy());
    expect(screen.queryByText(/Couldn't open this PDF/)).toBeNull();
  });
});

describe("ReaderScreen (unsupported formats)", () => {
  it("share-only formats explain themselves and open externally", async () => {
    const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as any);
    await renderReader({ itemId: ITEM, ebookFormat: "cbz", title: "Comic" });

    expect(
      await screen.findByText("CBZ ebooks can't be displayed in-app. Open it in a reader app that supports it.")
    ).toBeTruthy();

    // expo-sharing's isAvailableAsync is mocked false -> falls back to Linking.
    await fireEvent.press(screen.getByText("Open in another app"));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(EBOOK_URI));
  });

  it("close button leaves the reader", async () => {
    const { navigation } = await renderReader({ itemId: ITEM, ebookFormat: "cbz", title: "Comic" });
    await screen.findByText(/can't be displayed in-app/);

    await fireEvent.press(screen.getByLabelText("Close reader"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
