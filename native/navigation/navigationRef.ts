import { createNavigationContainerRef } from "@react-navigation/native";

import { usePlaybackStore } from "../store/usePlaybackStore";

export const navigationRef = createNavigationContainerRef();

export function navigate(name: string, params?: any) {
  if (name === "Player") {
    usePlaybackStore.getState().setPlayerExpanded(true);
    return;
  }
  if (navigationRef.isReady()) {
    (navigationRef.navigate as any)(name, params);
  }
}
