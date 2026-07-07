/**
 * BookProgressBadge — the dual-format (audio/ebook) progress chip matrix,
 * podcast episode summarization, downloaded chip, and null-render cases.
 *
 * Icons render as text glyphs (see jest.setup): cloud → "cloud-done",
 * check → "check", headphones → "headphones", book → "menu-book".
 */
import { render, screen } from "@testing-library/react-native";
import BookProgressBadge from "../../components/BookProgressBadge";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const userInitial = useUserStore.getState();
const downloadInitial = useDownloadStore.getState();

beforeEach(() => {
  useUserStore.setState(userInitial, true);
  useDownloadStore.setState(downloadInitial, true);
});

const audioItem = { mediaType: "book", media: { numTracks: 3 } };
const ebookItem = { mediaType: "book", media: { ebookFormat: "epub" } };
const bothItem = { mediaType: "book", media: { numTracks: 3, ebookFormat: "epub" } };

function seedProgress(map: Record<string, any>) {
  useUserStore.setState({ mediaProgress: map } as any);
}

describe("BookProgressBadge — books", () => {
  it("renders nothing when there is no progress and not downloaded", async () => {
    await render(<BookProgressBadge itemId="b1" item={audioItem} />);
    expect(screen.toJSON()).toBeNull();
  });

  it("audio-only in progress shows remaining time and headphones icon", async () => {
    seedProgress({ b1: { libraryItemId: "b1", progress: 0.5, currentTime: 1800, duration: 3600 } });
    await render(<BookProgressBadge itemId="b1" item={audioItem} />);
    expect(screen.getByText("30m")).toBeTruthy();
    expect(screen.getByText("headphones")).toBeTruthy();
    expect(screen.queryByText("check")).toBeNull();
    expect(screen.queryByText("menu-book")).toBeNull();
  });

  it("formats hours+minutes remaining (h m label)", async () => {
    // 25% of 8h book → 6h remaining
    seedProgress({ b1: { libraryItemId: "b1", progress: 0.25, currentTime: 7200, duration: 28800 } });
    await render(<BookProgressBadge itemId="b1" item={audioItem} />);
    expect(screen.getByText("6h 0m")).toBeTruthy();
  });

  it("ebook-only in progress shows percent label and book icon", async () => {
    seedProgress({ e1: { libraryItemId: "e1", ebookProgress: 0.42 } });
    await render(<BookProgressBadge itemId="e1" item={ebookItem} />);
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("menu-book")).toBeTruthy();
    expect(screen.queryByText("headphones")).toBeNull();
  });

  it("ebook-only falls back to `progress` field when ebookProgress missing", async () => {
    seedProgress({ e1: { libraryItemId: "e1", progress: 0.3 } });
    await render(<BookProgressBadge itemId="e1" item={ebookItem} />);
    expect(screen.getByText("30%")).toBeTruthy();
  });

  it("percent label clamps to 1–99 (never 0% / 100%)", async () => {
    seedProgress({ e1: { libraryItemId: "e1", ebookProgress: 0.001 } });
    await render(<BookProgressBadge itemId="e1" item={ebookItem} />);
    expect(screen.getByText("1%")).toBeTruthy();
  });

  it("both formats in progress shows combined 'remaining • percent'", async () => {
    seedProgress({
      b1: {
        libraryItemId: "b1",
        progress: 0.5,
        currentTime: 1800,
        duration: 3600,
        ebookProgress: 0.25,
      },
    });
    await render(<BookProgressBadge itemId="b1" item={bothItem} />);
    expect(screen.getByText("30m • 25%")).toBeTruthy();
    expect(screen.getByText("headphones")).toBeTruthy();
    expect(screen.getByText("menu-book")).toBeTruthy();
  });

  it("explicit isFinished finishes the whole book (both formats) → 'Finished' + check", async () => {
    seedProgress({
      b1: {
        libraryItemId: "b1",
        isFinished: true,
        progress: 1,
        currentTime: 3600,
        duration: 3600,
        ebookProgress: 0.4,
      },
    });
    // BUG?-check: explicit finish with readerSetFinished NOT triggered
    // (ebookFraction 0.4 < 0.99) → both formats finished → single label.
    await render(<BookProgressBadge itemId="b1" item={bothItem} />);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("check")).toBeTruthy();
    expect(screen.queryByText("headphones")).toBeNull();
  });

  it("audio-only finished shows 'Finished'", async () => {
    seedProgress({
      b1: { libraryItemId: "b1", isFinished: true, progress: 1, currentTime: 3600, duration: 3600 },
    });
    await render(<BookProgressBadge itemId="b1" item={audioItem} />);
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("readerSetFinished exception: ebook ≥99% + audio mid-flight keeps audio remaining visible", async () => {
    seedProgress({
      b1: {
        libraryItemId: "b1",
        isFinished: true, // reader auto-finish set the item-level flag
        progress: 0.5,
        currentTime: 1800,
        duration: 3600,
        ebookProgress: 0.995,
      },
    });
    await render(<BookProgressBadge itemId="b1" item={bothItem} />);
    // Ebook side is finished (check shows) but the audio remaining stays live.
    expect(screen.getByText("30m")).toBeTruthy();
    expect(screen.getByText("check")).toBeTruthy();
    expect(screen.getByText("headphones")).toBeTruthy();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("ebook ≥99% alone (no audio progress) reads as finished", async () => {
    seedProgress({ e1: { libraryItemId: "e1", ebookProgress: 0.995 } });
    await render(<BookProgressBadge itemId="e1" item={ebookItem} />);
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("downloaded with no progress shows 'Downloaded' + cloud icon", async () => {
    await render(<BookProgressBadge itemId="b1" item={audioItem} downloaded />);
    expect(screen.getByText("Downloaded")).toBeTruthy();
    expect(screen.getByText("cloud-done")).toBeTruthy();
  });

  it("downloaded via download store (completedDownloads) shows the cloud icon", async () => {
    useDownloadStore.setState({ completedDownloads: { b1: { id: "b1" } } } as any);
    seedProgress({ b1: { libraryItemId: "b1", progress: 0.5, currentTime: 1800, duration: 3600 } });
    await render(<BookProgressBadge itemId="b1" item={audioItem} />);
    // Downloaded indicator coexists with in-progress label.
    expect(screen.getByText("cloud-done")).toBeTruthy();
    expect(screen.getByText("30m")).toBeTruthy();
  });

  it("uses an explicit `progress` prop over the store entry", async () => {
    seedProgress({ b1: { libraryItemId: "b1", progress: 0.9, currentTime: 3240, duration: 3600 } });
    await render(
      <BookProgressBadge
        itemId="b1"
        item={audioItem}
        progress={{ progress: 0.5, currentTime: 1800, duration: 3600 }}
      />
    );
    expect(screen.getByText("30m")).toBeTruthy();
  });

  it("infers formats from the progress entry when no item payload is given", async () => {
    seedProgress({ b1: { libraryItemId: "b1", progress: 0.5, currentTime: 1800, duration: 3600 } });
    await render(<BookProgressBadge itemId="b1" />);
    expect(screen.getByText("30m")).toBeTruthy();
  });
});

describe("BookProgressBadge — podcasts", () => {
  const podcastItem = { mediaType: "podcast", media: { numEpisodes: 2 } };

  it("summarizes to the most recently played unfinished episode (composite keys)", async () => {
    seedProgress({
      "p1-ep1": {
        libraryItemId: "p1",
        episodeId: "ep1",
        progress: 0.25,
        currentTime: 300,
        duration: 1200,
        lastUpdate: 1000,
      },
      "p1-ep2": {
        libraryItemId: "p1",
        episodeId: "ep2",
        progress: 0.5,
        currentTime: 1800,
        duration: 3600,
        lastUpdate: 2000, // most recent → wins
      },
    });
    await render(<BookProgressBadge itemId="p1" item={podcastItem} />);
    expect(screen.getByText("30m")).toBeTruthy();
    expect(screen.getByText("headphones")).toBeTruthy();
  });

  it("shows 'Finished' only when every known episode is finished", async () => {
    seedProgress({
      "p1-ep1": { libraryItemId: "p1", episodeId: "ep1", isFinished: true },
      "p1-ep2": { libraryItemId: "p1", episodeId: "ep2", isFinished: true },
    });
    await render(<BookProgressBadge itemId="p1" item={podcastItem} />);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("check")).toBeTruthy();
  });

  it("does NOT show 'Finished' when only some episodes are done", async () => {
    seedProgress({
      "p1-ep1": { libraryItemId: "p1", episodeId: "ep1", isFinished: true },
    });
    await render(<BookProgressBadge itemId="p1" item={podcastItem} />);
    expect(screen.toJSON()).toBeNull();
  });

  it("plain-key (tick loop) finished entries don't double-count episodes", async () => {
    seedProgress({
      p1: { libraryItemId: "p1", isFinished: true }, // no episodeId → ignored for count
      "p1-ep1": { libraryItemId: "p1", episodeId: "ep1", isFinished: true },
    });
    await render(<BookProgressBadge itemId="p1" item={podcastItem} />);
    // 1 composite finished < 2 totalEpisodes → not "Finished", nothing else → null
    expect(screen.toJSON()).toBeNull();
  });

  it("explicit episode progress prop (finished) renders that episode's state", async () => {
    await render(
      <BookProgressBadge itemId="p1" item={podcastItem} progress={{ isFinished: true }} />
    );
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("explicit episode progress prop (in-flight) shows remaining time", async () => {
    await render(
      <BookProgressBadge
        itemId="p1"
        item={podcastItem}
        progress={{ progress: 0.25, currentTime: 900, duration: 3600 }}
      />
    );
    expect(screen.getByText("45m")).toBeTruthy();
  });

  it("explicit episode progress with no duration falls back to percent", async () => {
    await render(
      <BookProgressBadge itemId="p1" item={podcastItem} progress={{ progress: 0.25 }} />
    );
    expect(screen.getByText("25%")).toBeTruthy();
  });

  it("downloaded podcast with no episode progress shows 'Downloaded'", async () => {
    await render(<BookProgressBadge itemId="p1" item={podcastItem} downloaded />);
    expect(screen.getByText("Downloaded")).toBeTruthy();
  });

  it("renders nothing when no episode progress and not downloaded", async () => {
    await render(<BookProgressBadge itemId="p1" item={podcastItem} />);
    expect(screen.toJSON()).toBeNull();
  });
});

describe("bookStatusA11yLabel (spoken card status for TalkBack)", () => {
  const { bookStatusA11yLabel } = require("../../components/BookProgressBadge");

  it("spells out remaining time for an in-progress audiobook", () => {
    const item = { id: "b1", media: { audioFiles: [{}], duration: 36000 } };
    const label = bookStatusA11yLabel(
      item,
      { b1: { libraryItemId: "b1", duration: 36000, currentTime: 3600, progress: 0.1 } },
      false
    );
    expect(label).toContain("left");
    expect(label).toMatch(/hour|minute/);
  });

  it("says Finished, and appends Downloaded", () => {
    const item = { id: "b1", media: { audioFiles: [{}], duration: 100 } };
    expect(bookStatusA11yLabel(item, { b1: { libraryItemId: "b1", isFinished: true } }, true)).toBe(
      "Finished, Downloaded"
    );
  });

  it("returns empty for an untouched, undownloaded book", () => {
    const item = { id: "b1", media: { audioFiles: [{}], duration: 100 } };
    expect(bookStatusA11yLabel(item, {}, false)).toBe("");
  });

  it("summarizes a podcast to Downloaded or nothing", () => {
    const item = { id: "p1", mediaType: "podcast" };
    expect(bookStatusA11yLabel(item, {}, true)).toBe("Downloaded");
    expect(bookStatusA11yLabel(item, {}, false)).toBe("");
  });
});
