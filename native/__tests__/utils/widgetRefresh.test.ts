import { NativeModules } from "react-native";
import { refreshPlayerWidgets, refreshHomeRowWidget } from "../../utils/widgetRefresh";

describe("widget refresh helpers", () => {
  afterEach(() => {
    delete (NativeModules as any).WidgetRefresh;
  });

  it("no-op (without throwing) when the native module isn't present", () => {
    expect(() => refreshPlayerWidgets()).not.toThrow();
    expect(() => refreshHomeRowWidget()).not.toThrow();
  });

  it("refreshPlayerWidgets calls ONLY refreshPlayers (never the home-row path)", () => {
    const refreshPlayers = jest.fn();
    const refreshHomeRows = jest.fn();
    (NativeModules as any).WidgetRefresh = { refreshPlayers, refreshHomeRows };
    refreshPlayerWidgets();
    expect(refreshPlayers).toHaveBeenCalledTimes(1);
    expect(refreshHomeRows).not.toHaveBeenCalled();
  });

  it("refreshHomeRowWidget calls ONLY refreshHomeRows", () => {
    const refreshPlayers = jest.fn();
    const refreshHomeRows = jest.fn();
    (NativeModules as any).WidgetRefresh = { refreshPlayers, refreshHomeRows };
    refreshHomeRowWidget();
    expect(refreshHomeRows).toHaveBeenCalledTimes(1);
    expect(refreshPlayers).not.toHaveBeenCalled();
  });

  it("swallows a throwing native method", () => {
    (NativeModules as any).WidgetRefresh = {
      refreshPlayers: () => {
        throw new Error("boom");
      },
    };
    expect(() => refreshPlayerWidgets()).not.toThrow();
  });

  it("ignores a module missing the requested method", () => {
    (NativeModules as any).WidgetRefresh = {};
    expect(() => refreshPlayerWidgets()).not.toThrow();
    expect(() => refreshHomeRowWidget()).not.toThrow();
  });
});
