/**
 * EpisodeDownloadLive (stutter round 3): the per-episode download-state
 * boundary behind podcast episode rows. The episode lists no longer subscribe
 * whole screens to the download maps — a ≥1% progress write must re-render
 * ONLY the row whose composite key changed.
 */
import React from "react";
import { Text } from "react-native";
import { render, act, screen } from "@testing-library/react-native";
import EpisodeDownloadLive from "../../components/EpisodeDownloadLive";
import { useDownloadStore } from "../../store/useDownloadStore";

const dlInitial = useDownloadStore.getState();

const probe = jest.fn();

function Row({ k }: { k: string }) {
  return (
    <EpisodeDownloadLive downloadKey={k}>
      {({ epActiveDl, epDownloaded }) => {
        probe(k);
        return (
          <Text>
            {`${k}:${
              epDownloaded
                ? "done"
                : epActiveDl
                ? `dl${Math.round((epActiveDl.progress || 0) * 100)}`
                : "none"
            }`}
          </Text>
        );
      }}
    </EpisodeDownloadLive>
  );
}

const rendersFor = (k: string) => probe.mock.calls.filter((c) => c[0] === k).length;

beforeEach(() => {
  useDownloadStore.setState(dlInitial, true);
  useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} } as any);
  probe.mockClear();
});

describe("EpisodeDownloadLive", () => {
  it("tracks its own key through the download lifecycle", async () => {
    await render(<Row k="pod1::ep1" />);
    expect(screen.getByText("pod1::ep1:none")).toBeTruthy();

    await act(async () => {
      useDownloadStore.setState({
        activeDownloads: { "pod1::ep1": { status: "downloading", progress: 0.42 } },
      } as any);
    });
    expect(screen.getByText("pod1::ep1:dl42")).toBeTruthy();

    await act(async () => {
      useDownloadStore.setState({
        activeDownloads: {},
        completedDownloads: { "pod1::ep1": { id: "pod1::ep1" } },
      } as any);
    });
    expect(screen.getByText("pod1::ep1:done")).toBeTruthy();
  });

  it("a re-download in flight wins over the stale completed entry", async () => {
    useDownloadStore.setState({
      activeDownloads: { "pod1::ep1": { status: "downloading", progress: 0.1 } },
      completedDownloads: { "pod1::ep1": { id: "pod1::ep1" } },
    } as any);
    await render(<Row k="pod1::ep1" />);
    // Not "done": the retry's active entry masks the completed one, same as
    // the screens' old inline `completed && !active` derivation.
    expect(screen.getByText("pod1::ep1:dl10")).toBeTruthy();
  });

  it("another episode's progress writes do not re-render this row", async () => {
    await render(
      <>
        <Row k="pod1::ep1" />
        <Row k="pod1::ep2" />
      </>
    );
    probe.mockClear();

    // Simulate the gated per-percent writes of ep2's download only.
    for (const pct of [0.01, 0.02, 0.03]) {
      await act(async () => {
        useDownloadStore.setState({
          activeDownloads: { "pod1::ep2": { status: "downloading", progress: pct } },
        } as any);
      });
    }

    expect(rendersFor("pod1::ep2")).toBe(3);
    // ep1's slice stayed undefined through every write — zero re-renders.
    expect(rendersFor("pod1::ep1")).toBe(0);
    expect(screen.getByText("pod1::ep2:dl3")).toBeTruthy();
    expect(screen.getByText("pod1::ep1:none")).toBeTruthy();
  });
});
