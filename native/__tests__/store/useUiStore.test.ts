import { useUiStore } from "../../store/useUiStore";

const initial = useUiStore.getState();

describe("useUiStore", () => {
  beforeEach(() => {
    useUiStore.setState(initial, true);
  });

  it("has closed drawers and inactive search by default", () => {
    const s = useUiStore.getState();
    expect(s.drawerOpen).toBe(false);
    expect(s.librarySelectorOpen).toBe(false);
    expect(s.isSearchActive).toBe(false);
    expect(s.searchQuery).toBe("");
  });

  it("opens and closes the drawer", () => {
    useUiStore.getState().openDrawer();
    expect(useUiStore.getState().drawerOpen).toBe(true);
    useUiStore.getState().closeDrawer();
    expect(useUiStore.getState().drawerOpen).toBe(false);
  });

  it("opens and closes the library selector", () => {
    useUiStore.getState().openLibrarySelector();
    expect(useUiStore.getState().librarySelectorOpen).toBe(true);
    useUiStore.getState().closeLibrarySelector();
    expect(useUiStore.getState().librarySelectorOpen).toBe(false);
  });

  it("toggles search active state and query", () => {
    useUiStore.getState().setSearchActive(true);
    useUiStore.getState().setSearchQuery("dune");
    expect(useUiStore.getState().isSearchActive).toBe(true);
    expect(useUiStore.getState().searchQuery).toBe("dune");
    useUiStore.getState().setSearchActive(false);
    expect(useUiStore.getState().isSearchActive).toBe(false);
    // Query is independent of the active flag.
    expect(useUiStore.getState().searchQuery).toBe("dune");
  });
});
