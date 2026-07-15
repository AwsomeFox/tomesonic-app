import { NativeModules } from "react-native";
import { refreshWidgets } from "../../utils/widgetRefresh";

describe("refreshWidgets", () => {
  afterEach(() => {
    delete (NativeModules as any).WidgetRefresh;
  });

  it("no-ops (without throwing) when the native module isn't present", () => {
    expect(() => refreshWidgets()).not.toThrow();
  });

  it("calls the native module's refresh when available", () => {
    const refresh = jest.fn();
    (NativeModules as any).WidgetRefresh = { refresh };
    refreshWidgets();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing native module", () => {
    (NativeModules as any).WidgetRefresh = {
      refresh: () => {
        throw new Error("boom");
      },
    };
    expect(() => refreshWidgets()).not.toThrow();
  });

  it("ignores a module missing the refresh method", () => {
    (NativeModules as any).WidgetRefresh = {};
    expect(() => refreshWidgets()).not.toThrow();
  });
});
