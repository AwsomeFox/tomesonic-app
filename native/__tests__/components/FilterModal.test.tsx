/**
 * FilterModal — encodeFilterValue (base64 + URI encoding, unicode-safe),
 * top-level option list per library media type, sublist drill-in built from
 * filterData, selection emitting raw query values, and Clear Filter.
 */
import { render, screen, fireEvent } from "@testing-library/react-native";

// The global setup mock for react-native-safe-area-context only provides a
// `default` export, so NAMED imports (SafeAreaView / useSafeAreaInsets) resolve
// to undefined and crash the render. Override file-locally with named exports.
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaView: ({ children, ...props }: any) => React.createElement(View, props, children),
    SafeAreaProvider: ({ children }: any) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 320, height: 640 }),
  };
});

import FilterModal, { encodeFilterValue } from "../../components/FilterModal";
import { useLibraryStore } from "../../store/useLibraryStore";

const libraryInitial = useLibraryStore.getState();

beforeEach(() => {
  useLibraryStore.setState(libraryInitial, true);
});

function seedLibrary(overrides: any = {}) {
  useLibraryStore.setState({
    libraries: [
      { id: "lib1", name: "Books", mediaType: "book", settings: {} },
      { id: "lib2", name: "Pods", mediaType: "podcast", settings: {} },
    ],
    currentLibraryId: "lib1",
    filterData: {
      genres: ["Fantasy", "Sci-Fi"],
      tags: ["favorites"],
      series: [{ id: "ser1", name: "The Saga" }],
      authors: [{ id: "au1", name: "Brandon Sanderson" }],
      narrators: ["Ray Porter"],
      languages: ["English"],
    },
    fetchLibraryDetails: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any);
}

describe("encodeFilterValue", () => {
  it("base64-encodes then URI-encodes (ABS $encode convention)", () => {
    // btoa("in-progress") === "aW4tcHJvZ3Jlc3M=" → "=" URI-encodes to %3D
    expect(encodeFilterValue("in-progress")).toBe("aW4tcHJvZ3Jlc3M%3D");
  });

  it("round-trips plain ascii", () => {
    const enc = encodeFilterValue("Fantasy");
    expect(Buffer.from(decodeURIComponent(enc), "base64").toString("utf8")).toBe("Fantasy");
  });

  it("handles unicode values", () => {
    const value = "Épée & 日本語";
    const enc = encodeFilterValue(value);
    // URI-encoded base64 must decode back to the exact original utf8 string.
    expect(Buffer.from(decodeURIComponent(enc), "base64").toString("utf8")).toBe(value);
    // and must itself be URI-safe (no raw + / = leaking through)
    expect(enc).not.toMatch(/[=+/]/);
  });
});

describe("FilterModal", () => {
  const noop = () => {};

  it("shows the book top-level options for a book library", async () => {
    seedLibrary();
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={noop} />);
    for (const label of [
      "All",
      "Genre",
      "Tag",
      "Series",
      "Author",
      "Narrator",
      "Language",
      "Progress",
      "Ebooks",
      "Issues",
      "RSS Feed Open",
      "Explicit",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows the reduced podcast option set for a podcast library", async () => {
    seedLibrary({ currentLibraryId: "lib2" });
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={noop} />);
    expect(screen.getByText("Genre")).toBeTruthy();
    expect(screen.queryByText("Series")).toBeNull();
    expect(screen.queryByText("Narrator")).toBeNull();
    expect(screen.queryByText("Progress")).toBeNull();
  });

  it("commits a non-sublist top-level value directly", async () => {
    seedLibrary();
    const onChange = jest.fn();
    const onClose = jest.fn();
    await render(<FilterModal visible onClose={onClose} filterBy="all" onChange={onChange} />);
    await fireEvent.press(screen.getByText("Issues"));
    expect(onChange).toHaveBeenCalledWith("issues");
    expect(onClose).toHaveBeenCalled();
  });

  it("re-selecting the current filter just closes without onChange", async () => {
    seedLibrary();
    const onChange = jest.fn();
    const onClose = jest.fn();
    await render(<FilterModal visible onClose={onClose} filterBy="all" onChange={onChange} />);
    await fireEvent.press(screen.getByText("All"));
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("drills into a sublist and emits the base64-encoded raw value", async () => {
    seedLibrary();
    const onChange = jest.fn();
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={onChange} />);
    await fireEvent.press(screen.getByText("Genre"));
    expect(screen.getByText("Fantasy")).toBeTruthy();
    expect(screen.getByText("Sci-Fi")).toBeTruthy();
    await fireEvent.press(screen.getByText("Fantasy"));
    expect(onChange).toHaveBeenCalledWith(`genres.${encodeFilterValue("Fantasy")}`);
  });

  it("object-shaped sublist entries (authors) encode the id, not the name", async () => {
    seedLibrary();
    const onChange = jest.fn();
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={onChange} />);
    await fireEvent.press(screen.getByText("Author"));
    await fireEvent.press(screen.getByText("Brandon Sanderson"));
    expect(onChange).toHaveBeenCalledWith(`authors.${encodeFilterValue("au1")}`);
  });

  it("series sublist prepends the synthetic 'No Series' entry", async () => {
    seedLibrary();
    const onChange = jest.fn();
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={onChange} />);
    await fireEvent.press(screen.getByText("Series"));
    expect(screen.getByText("No Series")).toBeTruthy();
    expect(screen.getByText("The Saga")).toBeTruthy();
    await fireEvent.press(screen.getByText("No Series"));
    expect(onChange).toHaveBeenCalledWith(`series.${encodeFilterValue("no-series")}`);
  });

  it("progress sublist is static and encodes its ids", async () => {
    seedLibrary();
    const onChange = jest.fn();
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={onChange} />);
    await fireEvent.press(screen.getByText("Progress"));
    for (const label of ["Finished", "In Progress", "Not Started", "Not Finished"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    await fireEvent.press(screen.getByText("In Progress"));
    expect(onChange).toHaveBeenCalledWith("progress.aW4tcHJvZ3Jlc3M%3D");
  });

  it("Back row returns from the sublist to the top level", async () => {
    seedLibrary();
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={noop} />);
    await fireEvent.press(screen.getByText("Tag"));
    expect(screen.getByText("favorites")).toBeTruthy();
    await fireEvent.press(screen.getByText("Back"));
    expect(screen.queryByText("favorites")).toBeNull();
    expect(screen.getByText("Issues")).toBeTruthy();
  });

  it("Clear Filter resets to 'all'", async () => {
    seedLibrary();
    const onChange = jest.fn();
    const onClose = jest.fn();
    await render(
      <FilterModal visible onClose={onClose} filterBy="issues" onChange={onChange} />
    );
    await fireEvent.press(screen.getByText("Clear Filter"));
    expect(onChange).toHaveBeenCalledWith("all");
    expect(onClose).toHaveBeenCalled();
  });

  it("no Clear Filter affordance when the filter is 'all'", async () => {
    seedLibrary();
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={noop} />);
    expect(screen.queryByText("Clear Filter")).toBeNull();
  });

  it("restores the drilled-in sublist when reopened with a sublist selection", async () => {
    seedLibrary();
    const selected = `genres.${encodeFilterValue("Fantasy")}`;
    await render(<FilterModal visible onClose={noop} filterBy={selected} onChange={noop} />);
    // Opened directly inside the genres sublist.
    expect(screen.getByText("Fantasy")).toBeTruthy();
    expect(screen.getByText("Back")).toBeTruthy();
  });

  it("lazily fetches filterData when missing", async () => {
    const fetchLibraryDetails = jest.fn().mockResolvedValue(undefined);
    seedLibrary({ filterData: null, fetchLibraryDetails });
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={noop} />);
    expect(fetchLibraryDetails).toHaveBeenCalledWith("lib1");
  });

  it("shows an empty-sublist message when filterData has no entries", async () => {
    seedLibrary({ filterData: { genres: [] } });
    await render(<FilterModal visible onClose={noop} filterBy="all" onChange={noop} />);
    await fireEvent.press(screen.getByText("Genre"));
    expect(screen.getByText("No genres items")).toBeTruthy();
  });
});
