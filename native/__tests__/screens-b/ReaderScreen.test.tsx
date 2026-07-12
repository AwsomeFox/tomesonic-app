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
// expo-speech is now a real dependency; mock its native surface so the TTS path
// is exercisable in jest without touching a native module.
jest.mock("expo-speech", () => ({
  speak: jest.fn(),
  stop: jest.fn(),
  isSpeakingAsync: jest.fn().mockResolvedValue(false),
}));

import React from "react";
import { Linking, Share } from "react-native";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import ReaderScreen from "../../screens/ReaderScreen";
import { api } from "../../utils/api";
import { queueEbookProgressPatch } from "../../utils/progressSync";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { useDialogStore } from "../../store/useDialogStore";

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
  useDialogStore.setState({ current: null } as any);
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

  it("marks reading-settings section titles as headers for screen readers", async () => {
    await renderReader();
    await readyWebView();
    await fireEvent.press(screen.getByLabelText("Reading settings"));

    // Sheet title + section titles expose the header role so TalkBack/VoiceOver
    // can navigate by heading.
    expect(screen.getByText("Reading Settings").props.accessibilityRole).toBe("header");
    expect(screen.getByText("Margins").props.accessibilityRole).toBe("header");
    expect(screen.getByText("Layout").props.accessibilityRole).toBe("header");
    expect(screen.getByText("Time Left").props.accessibilityRole).toBe("header");
  });

  it("exposes the progress/time-left footer as a polite live region", async () => {
    await renderReader();
    const webProps = await readyWebView();
    await act(async () => {
      sendMsg(webProps, LOCATION);
    });

    // The footer announces page/percent/time-left changes without stealing focus.
    expect(
      screen.getByTestId("reader-progress-footer").props.accessibilityLiveRegion
    ).toBe("polite");
  });

  it("emits the finger-follow page-curl gesture code in the reader HTML by default", async () => {
    await renderReader();
    await readyWebView();

    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    // Curl handlers + a live toggle hook are present, enabled by default.
    expect(html).toContain("window.setPageCurl");
    expect(html).toContain("function finishTurn");
    expect(html).toContain("var curlEnabled = true;");
    // The curl is NOT gated on the OS reduced-motion preference — many Android
    // WebViews report reduce-motion and silently disabled it (#3). The "None"
    // setting is the user-facing motion accommodation.
    expect(html).not.toContain("prefers-reduced-motion");
    expect(html).not.toContain("reduceMotionOn");
  });

  it("bakes the curl OFF into the HTML when the user disabled it previously", async () => {
    storage.set("reader_page_curl", false);
    await renderReader();
    await readyWebView();

    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    expect(html).toContain("var curlEnabled = false");
  });

  it("binds the finger-follow curl to each section document with a real 3D fold", async () => {
    await renderReader();
    await readyWebView();

    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;

    // The curl handlers are bound to the section document (e.detail.doc) from
    // the 'load' handler, in the CAPTURE phase, so they run before foliate's own
    // bubble-phase swipe. Foliate renders the text in a same-origin iframe, so
    // outer-document listeners never saw touches over the page.
    expect(html).toContain("function attachPageTurn(doc)");
    expect(html).toContain("attachPageTurn(doc)"); // called from the load handler
    expect(html).toContain("doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })");
    // Suppress foliate's own swipe while a horizontal drag is in progress.
    expect(html).toContain("stopImmediatePropagation");

    // The overlay is a real page-curl fold, not a flat slide: a fold flap driven
    // by a 3D perspective + rotateY transform, gated on the curl setting.
    expect(html).toContain("pagecurl-fold");
    expect(html).toContain("perspective(1200px) rotateY");

    // The outer document is no longer the SOLE touch-registration path.
    expect(html).toContain("document.addEventListener('touchstart', onTouchStart");
  });

  it("applies live theme colors additively so foliate's column/margin layout survives", async () => {
    await renderReader();
    await readyWebView();

    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;

    // A setAttribute('style', ...) here replaced the whole inline style
    // attribute, wiping foliate's column-layout inline props (the page margin)
    // until the next render() — the margin collapsed on a theme change until a
    // page turn. Set only the two colors additively via setProperty instead.
    expect(html).not.toContain("setAttribute('style'");
    expect(html).toContain("setProperty('background', bg, 'important')");
    expect(html).toContain("setProperty('color', fg, 'important')");
  });

  it("toggling Page Turn persists the choice and flips it live in the WebView", async () => {
    await renderReader();
    await readyWebView();

    await fireEvent.press(screen.getByLabelText("Reading settings"));
    // Default on.
    expect(
      screen.getByLabelText("Page-turn curl animation").props.accessibilityState?.selected
    ).toBe(true);

    await fireEvent.press(screen.getByLabelText("No page-turn animation"));
    expect(storage.getBoolean("reader_page_curl")).toBe(false);
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.setPageCurl && window.setPageCurl(false)")
    );

    await fireEvent.press(screen.getByLabelText("Page-turn curl animation"));
    expect(storage.getBoolean("reader_page_curl")).toBe(true);
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.setPageCurl && window.setPageCurl(true)")
    );
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

describe("ReaderScreen — settings flush + linked catch-up on 'ready'", () => {
  const injectedAll = () =>
    ((global as any).__injectJS.mock.calls as any[]).map((c) => c[0]).join("\n");

  const sendReady = async (webProps: any) => {
    await act(async () => {
      webProps.onMessage({ nativeEvent: { data: JSON.stringify({ type: "ready" }) } });
    });
  };

  // R2: the per-setting live-apply effects gate on ebookStatus === "ready",
  // which flips on WebView MOUNT — before init() defines the window.setX
  // helpers — so a setting changed in that window no-op'd forever. The 'ready'
  // MESSAGE re-applies the whole current snapshot.
  it("R2: re-applies the full current settings snapshot on the 'ready' message", async () => {
    await renderReader();
    const webProps = await readyWebView();
    (global as any).__injectJS.mockClear();

    await sendReady(webProps);

    const injected = injectedAll();
    expect(injected).toContain("window.setReaderStyles");
    expect(injected).toContain("window.setReaderTheme");
    expect(injected).toContain("window.setReaderMargin");
    expect(injected).toContain("window.setReaderFlow");
    expect(injected).toContain("window.setPageCurl");
  });

  // P1/P2: the reader itself performs the forward-only linked seek, keyed off
  // its TRUE rendered page — fixing the self-defeating percentage gate and
  // every entry point at once.
  it("P1/P2: LINKED book listened ahead seeks the reader FORWARD to the audio fraction on ready", async () => {
    useUserStore.setState((s: any) => ({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, progress: 0.5, ebookProgress: 0.2, duration: 3600 },
      },
      settings: { ...s.settings, linkedProgress: { [ITEM]: true } },
    }));
    await renderReader();
    const webProps = await readyWebView();
    (global as any).__injectJS.mockClear();

    await sendReady(webProps);

    expect(injectedAll()).toContain("window.seekForwardToFraction(0.5)");
  });

  it("P1/P2: the linked auto-seek is FORWARD-ONLY in the WebView (never drags reading backward)", async () => {
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    // The forward-only comparison lives in the WebView, against the reader's
    // real rendered fraction (so "already read ahead" never seeks backward).
    expect(html).toContain("window.seekForwardToFraction");
    expect(html).toContain("target > cur + 0.001");
  });

  it("P1/P2: NON-linked book does NOT auto-seek on ready", async () => {
    useUserStore.setState((s: any) => ({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, progress: 0.5, ebookProgress: 0.2, duration: 3600 },
      },
    }));
    await renderReader();
    const webProps = await readyWebView();
    (global as any).__injectJS.mockClear();

    await sendReady(webProps);

    expect(injectedAll()).not.toContain("seekForwardToFraction");
  });

  it("P1/P2: an EXPLICIT initialFraction (Read-from-here) applies as-is and suppresses the auto-seek", async () => {
    useUserStore.setState((s: any) => ({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, progress: 0.5, ebookProgress: 0.2, duration: 3600 },
      },
      settings: { ...s.settings, linkedProgress: { [ITEM]: true } },
    }));
    await renderReader({ itemId: ITEM, ebookFormat: "epub", title: "My Book", initialFraction: 0.8 });
    const webProps = await readyWebView();
    (global as any).__injectJS.mockClear();

    await sendReady(webProps);

    const injected = injectedAll();
    expect(injected).toContain("goToFraction(0.8)");
    expect(injected).not.toContain("seekForwardToFraction");
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

  it("honors the Read-from-here pending jump for PDFs once the page count is known", async () => {
    await renderReader({ itemId: PDF_ITEM, ebookFormat: "pdf", title: "My PDF", initialFraction: 0.5 });
    await waitFor(() => expect((global as any).__pdfProps).toBeTruthy());
    // Until the document loads it sits on the restored/first page.
    expect((global as any).__pdfProps.page).toBe(1);

    // onLoadComplete reports the page count — the pending 0.5 fraction now maps
    // to a page (0.5 * 200 = 100), mirroring the epub goToFraction handoff.
    await act(async () => {
      (global as any).__pdfProps.onLoadComplete(200);
    });
    await waitFor(() => expect((global as any).__pdfProps.page).toBe(100));
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

  it("keeps the screen awake only while focused — activates on mount, releases on unmount", async () => {
    const { navigation, unmount } = await renderReader();

    expect(activateKeepAwakeAsync).toHaveBeenCalledWith("reader");
    // Subscribes to focus/blur so navigating forward (leaving it mounted but
    // blurred) releases the lock instead of holding it off-screen.
    expect(navigation.addListener).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(navigation.addListener).toHaveBeenCalledWith("blur", expect.any(Function));

    await act(async () => {
      unmount();
    });
    expect(deactivateKeepAwake).toHaveBeenCalledWith("reader");
  });
});

function sendMsg(webProps: any, payload: any) {
  webProps.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
}

describe("ReaderScreen (reader features)", () => {
  it("emits every new live-injection hook and the selection/annotation wiring in the HTML", async () => {
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;

    // Theme / margin / flow live hooks.
    expect(html).toContain("window.setReaderTheme");
    expect(html).toContain("window.setReaderMargin");
    expect(html).toContain("window.setReaderFlow");
    // Search + goToSearchResult.
    expect(html).toContain("window.search");
    expect(html).toContain("window.goToSearchResult");
    expect(html).toContain("view.search");
    // Highlights (foliate annotation API).
    expect(html).toContain("window.addHighlight");
    expect(html).toContain("window.removeHighlight");
    expect(html).toContain("view.addAnnotation");
    expect(html).toContain("draw-annotation");
    // Selection reporting + TTS text extraction.
    expect(html).toContain("type: 'selection'");
    expect(html).toContain("window.getReaderText");
  });

  it("the generated WebView module script COMPILES — template-escape regression guard", async () => {
    // The reader page is built inside a TS template literal, where a single
    // backslash escape (e.g. '\n' written as \n instead of \\n) silently
    // becomes a REAL newline inside a quoted JS string in the OUTPUT — a
    // module-wide syntax error that leaves the reader stuck on "Loading…"
    // with no error surfaced anywhere (this exact bug shipped once). The
    // script uses no import/export/TLA, so vm can compile it as a classic
    // script and throw on any syntax error.
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    const mod = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(mod).toBeTruthy();
    // The vendored foliate bundle is a real module (has exports) and is
    // static — strip it; the escape risk lives in OUR template code around it.
    const { FOLIATE_BUNDLE } = require("../../utils/foliateBundle");
    const ours = mod!.replace(FOLIATE_BUNDLE, "/* bundle */");
    expect(ours).not.toContain("export ");
    const vm = require("vm");
    expect(() => new vm.Script(ours)).not.toThrow();
  });

  it("sets the margin on view.renderer (not the <foliate-view> element) so it re-lays-out", async () => {
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;

    // Margin must be observed on the renderer (mirroring how `flow` is set),
    // otherwise changing the margin never re-lays-out the text.
    expect(html).toContain("view.renderer.setAttribute('margin', px + 'px')");
    // The initial margin is applied to the renderer after open, from the live
    // curMargin binding (which style/theme pushes re-assert — see issue #2).
    expect(html).toContain("view.renderer.setAttribute('margin', curMargin + 'px')");
    // The broken element-level margin assignment is gone.
    expect(html).not.toContain("view.setAttribute('margin'");
  });

  it("re-asserts the margin UNCONDITIONALLY in setReaderStyles and setReaderTheme (no equality guard)", async () => {
    // Regression: a theme (or font) change collapsed the page margin until a
    // manual page turn because the in-WebView re-assert was guarded by an
    // equality check that is always false after init, so foliate's render()
    // never re-ran. Both style/theme pushes must re-assert unconditionally —
    // setAttribute fires foliate's attributeChangedCallback → render() even
    // for an unchanged value, and that relayout is what restores the margin.
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;

    // The dead equality guard around the margin re-assert must be gone.
    expect(html).not.toContain("getAttribute('margin') !==");
    // Both hooks re-assert the live margin directly on the renderer.
    const stylesBody = /window\.setReaderStyles = \(css\) => \{([\s\S]*?)\n {6}\};/.exec(html)?.[1];
    expect(stylesBody).toBeTruthy();
    expect(stylesBody).toContain("view.renderer.setAttribute('margin', curMargin + 'px')");
    expect(stylesBody).not.toContain("getAttribute('margin')");

    const themeBody = /window\.setReaderTheme = function\(nbg, nfg\)\{([\s\S]*?)\n {6}\};/.exec(html)?.[1];
    expect(themeBody).toBeTruthy();
    expect(themeBody).toContain("view.renderer.setAttribute('margin', curMargin + 'px')");
    expect(themeBody).not.toContain("getAttribute('margin')");
  });

  it("defaults theme/margin/flow into the HTML and bakes stored preferences", async () => {
    // Defaults: 16px margin, paginated flow.
    await renderReader();
    await readyWebView();
    let html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    expect(html).toContain("let curMargin = 16;");
    expect(html).toContain("'paginated'");
  });

  it("bakes a stored sepia theme, wide margin, and scrolled flow into the HTML", async () => {
    storage.set("reader_theme", "sepia");
    storage.set("reader_margin", 32);
    storage.set("reader_flow", "scrolled");
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    // Sepia bg/fg baked as the initial theme colors.
    expect(html).toContain("#f4ecd8");
    expect(html).toContain("#5b4636");
    // Wide margin + scrolled flow.
    expect(html).toContain("let curMargin = 32;");
    expect(html).toContain('"scrolled"');
  });

  it("theme/margin/layout controls persist to MMKV and inject live", async () => {
    await renderReader();
    await readyWebView();
    await fireEvent.press(screen.getByLabelText("Reading settings"));

    await fireEvent.press(screen.getByLabelText("Sepia theme"));
    expect(storage.getString("reader_theme")).toBe("sepia");
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.setReaderTheme")
    );
    // Belt-and-braces: the theme effect ALSO re-pushes the margin so it is
    // restored independent of the in-WebView re-assert machinery (default
    // margin is 16).
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringMatching(
        /window\.setReaderTheme &&[\s\S]*window\.setReaderMargin && window\.setReaderMargin\(16\)/
      )
    );

    await fireEvent.press(screen.getByLabelText("Wide margins"));
    expect(storage.getNumber("reader_margin")).toBe(32);
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.setReaderMargin && window.setReaderMargin(32)")
    );

    await fireEvent.press(screen.getByLabelText("Scrolled layout"));
    expect(storage.getString("reader_flow")).toBe("scrolled");
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining('window.setReaderFlow && window.setReaderFlow("scrolled")')
    );
  });

  it("shows a whole-book time-left estimate from a persisted, clamped book speed", async () => {
    // Book scope: 0.01 fraction/min (within the sane clamp band) -> 50%
    // remaining ≈ 50 min.
    storage.set("reader_estimate_scope", "book");
    storage.set(`reader_speed_${ITEM}`, 0.01);
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, { ...LOCATION, fraction: 0.5 });
    });

    expect(screen.getByText("~50 min left in book")).toBeTruthy();
  });

  it("clamps a poisoned persisted book speed so it can't collapse to '~2 min'", async () => {
    // A poisoned huge book speed (from a fast early flip) would imply a
    // whole-book time far under 30 min; the clamp holds 1/bookSpeed >= 30 min,
    // so at 5% read the estimate stays believable rather than "~2 min".
    storage.set("reader_estimate_scope", "book");
    storage.set(`reader_speed_${ITEM}`, 5); // absurd fraction/min
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, { ...LOCATION, fraction: 0.05 });
    });
    // bookSpeed clamped to 1/30 -> ceil(0.95 / (1/30)) = ceil(28.5) = 29 min.
    expect(screen.getByText("~29 min left in book")).toBeTruthy();
  });

  it("heals a poisoned persisted rate/speed back to MMKV on load", async () => {
    // Clamp-on-read must WRITE the clamped value back so MMKV is fixed now, not
    // only after the next valid sample.
    storage.set(`reader_speed_${ITEM}`, 5); // absurd fraction/min → clamp to 1/30
    storage.set(`reader_rate_${ITEM}`, 999); // absurd pages/min → clamp to the max
    await renderReader();
    await readyWebView();

    expect(storage.getNumber(`reader_speed_${ITEM}`)).toBeCloseTo(1 / 30, 5);
    // Clamped pages/min rate persisted (no longer 999).
    expect(storage.getNumber(`reader_rate_${ITEM}`)).not.toBe(999);
    expect(storage.getNumber(`reader_rate_${ITEM}`)!).toBeLessThanOrEqual(8);
  });

  it("does NOT write a rate for a fresh book with no persisted sample", async () => {
    await renderReader();
    await readyWebView();
    // A never-read book keeps 0 (no estimate) — the heal-on-load must not
    // fabricate a rate out of the clamp minimum.
    expect(storage.getNumber(`reader_rate_${ITEM}`)).toBeUndefined();
    expect(storage.getNumber(`reader_speed_${ITEM}`)).toBeUndefined();
  });

  it("shows a chapter time-left estimate (default scope) from the clamped pages/min rate", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    await renderReader();
    const webProps = await readyWebView();

    // First relocate seeds the sample (no rate yet -> estimate hidden).
    await act(async () => {
      sendLocation(webProps, { ...LOCATION, page: 10, pages: 100, section: 1, fraction: 0.1 });
    });
    expect(screen.queryByText(/min left in chapter/)).toBeNull();

    // 1 minute later, 2 pages further in the same section -> 2 pages/min.
    // 88 pages remain (page 12 of 100) -> ceil(88 / 2) = 44 min left in chapter.
    jest.setSystemTime(60000);
    await act(async () => {
      sendLocation(webProps, { ...LOCATION, page: 12, pages: 100, section: 1, fraction: 0.12 });
    });
    expect(screen.getByText("~44 min left in chapter")).toBeTruthy();
    jest.useRealTimers();
  });

  it("keeps the time-left estimate hidden until a reading sample exists", async () => {
    await renderReader();
    const webProps = await readyWebView();
    await act(async () => {
      sendLocation(webProps, { ...LOCATION, fraction: 0.3 });
    });
    expect(screen.queryByText(/min left/)).toBeNull();
  });

  it("toggles the time-left scope live between chapter and book", async () => {
    storage.set(`reader_speed_${ITEM}`, 0.01); // book speed for the book estimate
    jest.useFakeTimers();
    jest.setSystemTime(0);
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendLocation(webProps, { ...LOCATION, page: 10, pages: 100, section: 1, fraction: 0.4 });
    });
    jest.setSystemTime(60000);
    await act(async () => {
      sendLocation(webProps, { ...LOCATION, page: 12, pages: 100, section: 1, fraction: 0.5 });
    });
    jest.useRealTimers();

    // Default chapter scope: 2 pages/min, 88 pages left -> ceil(88/2) = 44 min.
    expect(screen.getByText("~44 min left in chapter")).toBeTruthy();

    // Switch to Book in the settings sheet — footer re-derives live (no reload).
    await fireEvent.press(screen.getByLabelText("Reading settings"));
    await fireEvent.press(screen.getByLabelText("Time left in book"));
    expect(storage.getString("reader_estimate_scope")).toBe("book");
    // Book speed EMA settled near 0.1 fraction/min -> clamped to 1/30 max ->
    // ceil(0.5 / (1/30)) = 15 min.
    expect(screen.getByText("~15 min left in book")).toBeTruthy();
  });

  it("applies a named reader theme to the reader chrome, not just the book text", async () => {
    // Sepia selected -> the header title AND footer text adopt the sepia
    // foreground, so the whole reader screen is sepia (#2), not just the middle
    // text rectangle.
    storage.set("reader_theme", "sepia");
    await renderReader();
    const webProps = await readyWebView();

    // Header title uses the themed foreground.
    const title = screen.getByText("My Book");
    expect((title.props.style as any).color).toBe("#5b4636");

    // Footer (renders after a relocate) uses the dimmed themed foreground.
    await act(async () => {
      sendLocation(webProps, LOCATION);
    });
    const footer = screen.getByText("Page 10 of 100 (42%)");
    expect((footer.props.style as any).color).toBe("#5b463699");
  });

  it("keeps the app chrome colors when the reader theme is auto (no regression)", async () => {
    // reader_theme unset -> "auto" -> the header title must NOT use a named
    // theme foreground (it keeps the app onSurface color).
    await renderReader();
    await readyWebView();
    const title = screen.getByText("My Book");
    expect((title.props.style as any).color).not.toBe("#5b4636");
  });

  it("puts the reading-settings sections in a ScrollView so nothing is clipped", async () => {
    await renderReader();
    await readyWebView();
    await fireEvent.press(screen.getByLabelText("Reading settings"));
    // A bounded, scrollable container wraps the sections (Tools ... Time Left).
    expect(screen.getByTestId("reader-settings-scroll")).toBeTruthy();
    // The last section is reachable inside it.
    expect(screen.getByLabelText("Time left in chapter")).toBeTruthy();
    expect(screen.getByText("Margins")).toBeTruthy();
  });

  it("runs an in-book search, lists results, and navigates to a match's CFI", async () => {
    await renderReader();
    const webProps = await readyWebView();

    // Search moved out of the crowded header into the reading-settings sheet.
    await fireEvent.press(screen.getByLabelText("Reading settings"));
    await fireEvent.press(screen.getByLabelText("Search in book"));
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Search query"), "dragons");
    });
    (global as any).__injectJS.mockClear();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Run search"));
    });

    // Query is JSON-escaped into the injected search call.
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining('window.search(\"dragons\")')
    );

    // Results stream back via postMessage.
    await act(async () => {
      sendMsg(webProps, { type: "searchResult", cfi: "epubcfi(/6/4!/2)", excerpt: "here be dragons", label: "Chapter 3" });
      sendMsg(webProps, { type: "searchDone" });
    });
    expect(screen.getByText("here be dragons")).toBeTruthy();

    // Tapping a result injects goToSearchResult with the escaped CFI.
    (global as any).__injectJS.mockClear();
    await fireEvent.press(screen.getByText("here be dragons"));
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining('window.goToSearchResult && window.goToSearchResult("epubcfi(/6/4!/2)")')
    );
  });

  it("gates the search UI off when the bundle reports no search API", async () => {
    await renderReader();
    const webProps = await readyWebView();
    await act(async () => {
      sendMsg(webProps, { type: "ready", search: false });
    });

    await fireEvent.press(screen.getByLabelText("Reading settings"));
    await fireEvent.press(screen.getByLabelText("Search in book"));
    expect(screen.getByText("Search isn't available for this book.")).toBeTruthy();
    expect(screen.queryByLabelText("Search query")).toBeNull();
  });

  it("opens the selection action sheet and looks a word up via the OS", async () => {
    const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as any);
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendMsg(webProps, { type: "selection", text: "petrichor", cfi: "epubcfi(/6/4!/8,/1:0,/1:9)" });
    });

    expect(screen.getByText('"petrichor"')).toBeTruthy();
    // Relabeled to be honest: this opens a Google web search, not a dictionary.
    await fireEvent.press(screen.getByLabelText("Search the web"));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("define%20petrichor"))
    );
  });

  it("highlights a selection: persists to MMKV, injects the annotation, and lists/deletes it", async () => {
    await renderReader();
    const webProps = await readyWebView();

    const cfi = "epubcfi(/6/4!/8,/1:0,/1:9)";
    await act(async () => {
      sendMsg(webProps, { type: "selection", text: "the quick brown fox", cfi });
    });

    (global as any).__injectJS.mockClear();
    await fireEvent.press(screen.getByLabelText("Highlight"));

    // Persisted locally, keyed by item.
    const stored = JSON.parse(storage.getString(`reader_highlights_${ITEM}`) as string);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ cfi, text: "the quick brown fox" });
    // Drawn via the foliate annotation API.
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.addHighlight")
    );

    // Appears in the highlights sheet (opened from the settings sheet now, not
    // the header); deleting removes it + un-draws it.
    await fireEvent.press(screen.getByLabelText("Reading settings"));
    await fireEvent.press(screen.getByLabelText("Highlights"));
    expect(screen.getByText("the quick brown fox")).toBeTruthy();
    // The sheet says highlights are device-only so the user isn't misled into
    // thinking they sync.
    expect(screen.getByText("Saved on this device")).toBeTruthy();
    (global as any).__injectJS.mockClear();

    // Tapping delete only opens a confirm dialog — nothing is removed yet.
    await fireEvent.press(screen.getByLabelText("Delete highlight"));
    expect(useDialogStore.getState().current?.title).toBe("Delete highlight?");
    expect((global as any).__injectJS).not.toHaveBeenCalled();
    expect(JSON.parse(storage.getString(`reader_highlights_${ITEM}`) as string)).toHaveLength(1);

    // Confirming the dialog un-draws it and drops it from storage.
    const del = useDialogStore.getState().current?.buttons.find((b) => b.text === "Delete");
    await act(async () => {
      del?.onPress?.();
    });
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.removeHighlight")
    );
    expect(JSON.parse(storage.getString(`reader_highlights_${ITEM}`) as string)).toHaveLength(0);
  });

  it("re-applies stored highlights via the annotation API on WebView ready", async () => {
    storage.set(
      `reader_highlights_${ITEM}`,
      JSON.stringify([{ cfi: "epubcfi(/6/2!/4)", text: "old", color: "rgba(255,213,0,.4)", at: 1 }])
    );
    await renderReader();
    const webProps = await readyWebView();

    (global as any).__injectJS.mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ready", search: true });
    });
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining('window.addHighlight && window.addHighlight("epubcfi(/6/2!/4)"')
    );
  });

  it("shares the selected text as a quote (text-only, no native deps)", async () => {
    const shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" } as any);
    await renderReader();
    const webProps = await readyWebView();

    await act(async () => {
      sendMsg(webProps, { type: "selection", text: "to be or not to be", cfi: "epubcfi(x)" });
    });
    await fireEvent.press(screen.getByLabelText("Share quote"));

    await waitFor(() =>
      expect(shareSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("to be or not to be") })
      )
    );
  });

  it("read-aloud (expo-speech) asks the WebView for text and speaks it", async () => {
    const Speech = require("expo-speech");
    const webProps = await (async () => { await renderReader(); return readyWebView(); })();

    // Pressing "Read aloud" asks the WebView for the current section's text.
    await fireEvent.press(screen.getByLabelText("Read aloud"));
    expect((global as any).__injectJS).toHaveBeenCalledWith(
      expect.stringContaining("window.getReaderText")
    );

    // When the text comes back, it is spoken.
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "Once upon a time" });
    });
    expect(Speech.speak).toHaveBeenCalledWith("Once upon a time", expect.any(Object));
  });

  it("applies the selected read-aloud rate to the Speech.speak call", async () => {
    const Speech = require("expo-speech");
    await renderReader();
    const webProps = await readyWebView();

    // Bump the rate from the default 1.0x to 1.1x in the reading settings sheet.
    await fireEvent.press(screen.getByLabelText("Reading settings"));
    await fireEvent.press(screen.getByLabelText("Increase read-aloud speed"));
    expect(screen.getByText("1.1x")).toBeTruthy();
    expect(storage.getNumber("reader_tts_rate")).toBeCloseTo(1.1);

    // Start read-aloud and feed it text; the utterance carries the new rate.
    await fireEvent.press(screen.getByLabelText("Read aloud"));
    (Speech.speak as jest.Mock).mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "Once upon a time", pos: 0 });
    });
    const speakOpts = (Speech.speak as jest.Mock).mock.calls[0][1];
    expect(speakOpts.rate).toBeCloseTo(1.1);
  });

  it("clamps the read-aloud rate to its lower bound", async () => {
    storage.set("reader_tts_rate", 0.5);
    await renderReader();
    await readyWebView();

    await fireEvent.press(screen.getByLabelText("Reading settings"));
    // Already at the floor — the decrease control is disabled and the value
    // can't step below TTS_RATE_MIN.
    expect(screen.getByText("0.5x")).toBeTruthy();
    expect(
      screen.getByLabelText("Decrease read-aloud speed").props.accessibilityState?.disabled
    ).toBe(true);
  });

  it("chunks a long page under Android's ~4000-char TTS limit and advances only after the last chunk", async () => {
    const Speech = require("expo-speech");
    await renderReader();
    const webProps = await readyWebView();

    await fireEvent.press(screen.getByLabelText("Read aloud"));
    // ~10.8k chars — well over Android's 4000-char speak() ceiling.
    const longText = "sentence ".repeat(1200).trim();
    (Speech.speak as jest.Mock).mockClear();
    (global as any).__injectJS.mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: longText, pos: 0.1 });
    });

    // The first utterance stays under the limit.
    const firstArg = (Speech.speak as jest.Mock).mock.calls[0][0] as string;
    expect(firstArg.length).toBeLessThanOrEqual(3500);
    expect(firstArg.length).toBeGreaterThan(0);

    // Walk the chunk chain: each onDone speaks the next chunk; the page only
    // turns (window.goNext) after the final chunk.
    let guard = 0;
    while (guard++ < 25) {
      const calls = (Speech.speak as jest.Mock).mock.calls;
      const last = calls[calls.length - 1][1];
      await act(async () => {
        last.onDone();
      });
      const advanced = (global as any).__injectJS.mock.calls.some((c: any[]) =>
        String(c[0]).includes("window.goNext")
      );
      if (advanced) break;
    }
    expect((global as any).__injectJS).toHaveBeenCalledWith(expect.stringContaining("window.goNext"));
    // A >3500-char page needed more than one utterance.
    expect((Speech.speak as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    // Every utterance respected the limit.
    for (const c of (Speech.speak as jest.Mock).mock.calls) {
      expect((c[0] as string).length).toBeLessThanOrEqual(3500);
    }
  });

  it("stops read-aloud at the end of the book instead of looping the same text", async () => {
    const Speech = require("expo-speech");
    await renderReader();
    const webProps = await readyWebView();

    await fireEvent.press(screen.getByLabelText("Read aloud"));
    expect(screen.getByLabelText("Stop read-aloud")).toBeTruthy();

    (Speech.speak as jest.Mock).mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "the last page", pos: 0.99 });
    });
    expect(Speech.speak).toHaveBeenCalledTimes(1);

    // Finishing the page asks the WebView to turn + re-read.
    (global as any).__injectJS.mockClear();
    await act(async () => {
      (Speech.speak as jest.Mock).mock.calls[0][1].onDone();
    });
    expect((global as any).__injectJS).toHaveBeenCalledWith(expect.stringContaining("window.goNext"));

    // goNext() was a no-op (end of book): the SAME text at the SAME position
    // comes back. It must NOT be spoken again — read-aloud ends cleanly.
    (Speech.speak as jest.Mock).mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "the last page", pos: 0.99 });
    });
    expect(Speech.speak).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Read aloud")).toBeTruthy();
  });

  it("skips a blank/image section while reading, then stops when it can't advance further", async () => {
    const Speech = require("expo-speech");
    await renderReader();
    const webProps = await readyWebView();
    await fireEvent.press(screen.getByLabelText("Read aloud"));

    // Empty page while playing -> advance a page and retry (do not stop).
    (global as any).__injectJS.mockClear();
    (Speech.speak as jest.Mock).mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "", pos: 0.5 });
    });
    expect(Speech.speak).not.toHaveBeenCalled();
    expect((global as any).__injectJS).toHaveBeenCalledWith(expect.stringContaining("window.goNext"));
    expect(screen.getByLabelText("Stop read-aloud")).toBeTruthy(); // still active

    // Another empty page at the SAME position (can't advance = end) -> stop.
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "", pos: 0.5 });
    });
    expect(screen.getByLabelText("Read aloud")).toBeTruthy();
  });

  it("does not speak when read-aloud was stopped before the async text arrived (race)", async () => {
    const Speech = require("expo-speech");
    await renderReader();
    const webProps = await readyWebView();

    await fireEvent.press(screen.getByLabelText("Read aloud")); // start intent
    await fireEvent.press(screen.getByLabelText("Stop read-aloud")); // immediate stop

    (Speech.speak as jest.Mock).mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "should not speak", pos: 0.1 });
    });
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it("does not disable the page-curl under OS reduced-motion — the None setting is the off switch", async () => {
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;

    // The explicit setting drives the curl directly; no matchMedia gating that
    // an Android WebView reporting reduce-motion could silently trip (#3).
    expect(html).not.toContain("reduceMotionMql");
    expect(html).not.toContain("reduceMotionOn");
    expect(html).toContain("var curlEnabled = true;");
    expect(html).toContain("window.setPageCurl = function(v){ curlEnabled = !!v; };");
    // getReaderText reports the reading position so end-of-book is detectable.
    expect(html).toContain("pos: lastFraction");
    // getReaderText starts from the CURRENT reading position, not chapter top (#5).
    expect(html).toContain("view.lastLocation");
    expect(html).toContain("selectNodeContents");
  });

  it("does NOT start the loading-placeholder pulse loop under OS reduced motion", async () => {
    const reanimated = require("react-native-reanimated");
    const reduced = jest.spyOn(reanimated, "useReducedMotion").mockReturnValue(true);
    const loop = jest.spyOn(require("react-native").Animated, "loop");
    await renderReader();
    await readyWebView();
    // The ambient breathing pulse must never be scheduled when the OS asks to
    // reduce motion — the placeholder holds a static opacity instead.
    expect(loop).not.toHaveBeenCalled();
    reduced.mockRestore();
    loop.mockRestore();
  });
});

describe("ReaderScreen — R1 (page-bounded read-aloud), R5 (a11y headers), R6 (TTS unmount)", () => {
  // R1: read-aloud must extract only the CURRENT PAGE. The old code clamped the
  // range START to the cursor but left the END at the section end, so the TTS
  // advance (window.goNext turns ONE page) re-requested cursor→end-of-section
  // again — re-reading a multi-page chapter ~N times. Bounding the range END to
  // the visible page makes goNext advance one page at a time.
  it("R1: getReaderText bounds the range to the CURRENT PAGE (start AND end), not the section tail", async () => {
    await renderReader();
    await readyWebView();
    const html = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1] as string;
    expect(html).toContain("r.setStart(range.startContainer");
    // The end is clamped to the page's end container — the fix for #R1.
    expect(html).toContain("r.setEnd(range.endContainer");
    expect(html).toContain("range.endContainer");
  });

  // R5: header roles let TalkBack/VoiceOver navigate by heading, matching the
  // settings-sheet section titles that already expose the role.
  it("R5: the book title exposes the header role", async () => {
    await renderReader();
    await readyWebView();
    expect(screen.getByText("My Book").props.accessibilityRole).toBe("header");
  });

  it("R5: the TOC modal title exposes the header role", async () => {
    await renderReader();
    await readyWebView();
    await fireEvent.press(screen.getByLabelText("Table of contents"));
    expect(screen.getByText("Table of Contents").props.accessibilityRole).toBe("header");
  });

  it("R5: the Search modal title exposes the header role", async () => {
    await renderReader();
    await readyWebView();
    await fireEvent.press(screen.getByLabelText("Reading settings"));
    await fireEvent.press(screen.getByLabelText("Search in book"));
    expect(screen.getByText("Search in Book").props.accessibilityRole).toBe("header");
  });

  // R6: expo-speech's onStopped/onDone/onError fire ASYNCHRONOUSLY. The unmount
  // cleanup calls Speech.stop(), whose onStopped resolves after teardown — the
  // callbacks must no-op (guarded by unmountedRef) rather than setState / keep
  // paging.
  it("R6: TTS speech callbacks no-op after unmount (no further speak, no throw)", async () => {
    const Speech = require("expo-speech");
    const { unmount } = await renderReader();
    const webProps = await readyWebView();

    await fireEvent.press(screen.getByLabelText("Read aloud"));
    (Speech.speak as jest.Mock).mockClear();
    await act(async () => {
      sendMsg(webProps, { type: "ttsText", text: "a page of words", pos: 0.1 });
    });
    const opts = (Speech.speak as jest.Mock).mock.calls[0][1];

    // Screen tears down; the native callbacks resolve AFTER unmount.
    (Speech.speak as jest.Mock).mockClear();
    unmount();
    expect(() =>
      act(() => {
        opts.onDone();
        opts.onStopped();
        opts.onError();
      })
    ).not.toThrow();
    // onDone would normally chain to the next chunk — guarded off after unmount.
    expect(Speech.speak).not.toHaveBeenCalled();
  });
});
