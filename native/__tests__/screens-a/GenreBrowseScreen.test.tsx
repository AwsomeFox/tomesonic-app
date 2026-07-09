/**
 * GenreBrowseScreen — fetches /filterdata, renders a searchable genres/tags
 * list, navigates to the pushed Library list filtered by the tapped value
 * (base64 `genres.<enc>` / `tags.<enc>`), and covers loading/empty/offline
 * states.
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
// Controllable connectivity per test.
jest.mock("../../hooks/useNetworkStatus", () => {
  const useNetworkStatus = jest.fn(() => ({ isConnected: true, isInternetReachable: true, isOffline: false }));
  return { useNetworkStatus, default: useNetworkStatus };
});

import GenreBrowseScreen from "../../screens/GenreBrowseScreen";
import { api } from "../../utils/api";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import { useLibraryStore } from "../../store/useLibraryStore";
import { encodeFilterValue } from "../../components/FilterModal";

const mockedGet = api.get as jest.Mock;
const mockedNet = useNetworkStatus as jest.Mock;

const initialLibrary = useLibraryStore.getState();

const makeNavigation = () => {
  const navigation: any = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
};

const filterData = {
  genres: ["Science Fiction", "Fantasy", "History"],
  tags: ["Favorites", "To Read"],
};

beforeEach(() => {
  useLibraryStore.setState(initialLibrary, true);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: true, isOffline: false });
  mockedGet.mockResolvedValue({ data: filterData });
});

describe("GenreBrowseScreen", () => {
  it("fetches filterdata and renders the genres list", async () => {
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);

    await screen.findByText("Science Fiction");
    expect(screen.getByText("Fantasy")).toBeTruthy();
    expect(screen.getByText("History")).toBeTruthy();
    expect(mockedGet).toHaveBeenCalledWith("/api/libraries/lib1/filterdata");
  });

  it("tapping a genre navigates to the Library list with the base64 genres filter", async () => {
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);

    const row = await screen.findByLabelText("Science Fiction, opens list");
    fireEvent.press(row);
    expect(navigation.navigate).toHaveBeenCalledWith("Library", {
      filter: `genres.${encodeFilterValue("Science Fiction")}`,
      showBack: true,
      title: "Science Fiction",
    });
  });

  it("switching to the Tags tab renders tags and navigates with the tags filter", async () => {
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);
    await screen.findByText("Science Fiction");

    fireEvent.press(screen.getByLabelText("Tags"));
    const tagRow = await screen.findByLabelText("Favorites, opens list");
    fireEvent.press(tagRow);
    expect(navigation.navigate).toHaveBeenCalledWith("Library", {
      filter: `tags.${encodeFilterValue("Favorites")}`,
      showBack: true,
      title: "Favorites",
    });
  });

  it("opens directly to tags when the initialTab route param is 'tags'", async () => {
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: { initialTab: "tags" } }} />);
    await screen.findByText("Favorites");
    expect(screen.queryByText("Science Fiction")).toBeNull();
  });

  it("filters the list as the user types in the search box", async () => {
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);
    await screen.findByText("Science Fiction");

    fireEvent.changeText(screen.getByLabelText("Search genres"), "fan");
    await waitFor(() => expect(screen.queryByText("Science Fiction")).toBeNull());
    expect(screen.getByText("Fantasy")).toBeTruthy();
  });

  it("shows the offline empty state without fetching", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false, isOffline: true });
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);
    await screen.findByText("You're offline");
  });

  it("reloads the genres list when connectivity is regained (offline → online)", async () => {
    // Start offline: the screen shows the offline placeholder with no data.
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false, isOffline: true });
    const navigation = makeNavigation();
    const { rerender } = await render(
      <GenreBrowseScreen navigation={navigation} route={{ params: {} }} />
    );
    await screen.findByText("You're offline");
    mockedGet.mockClear();

    // Connectivity returns — the effect must re-fetch and render the list
    // rather than stranding the user on the offline placeholder.
    mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: true, isOffline: false });
    await act(async () => {
      rerender(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);
    });

    await screen.findByText("Science Fiction");
    expect(mockedGet).toHaveBeenCalledWith("/api/libraries/lib1/filterdata");
  });

  it("shows an error state with retry when the fetch fails", async () => {
    mockedGet.mockRejectedValueOnce(new Error("boom"));
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);

    await screen.findByText("Couldn't load genres");
    mockedGet.mockResolvedValueOnce({ data: filterData });
    fireEvent.press(screen.getByLabelText("Retry"));
    await screen.findByText("Science Fiction");
  });

  it("renders an empty state when the library has no genres", async () => {
    mockedGet.mockResolvedValue({ data: { genres: [], tags: [] } });
    const navigation = makeNavigation();
    await render(<GenreBrowseScreen navigation={navigation} route={{ params: {} }} />);
    await screen.findByText("No genres yet");
  });
});
