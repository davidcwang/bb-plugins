// bb-plugin-beautiful-chat — restyles BB's native chat in BeautifulUI's design
// language. Styling lives in app.css, switched per feature by attributes on
// <html> that mirror the plugin settings; this overlay renders nothing.
import "./app.css";
import { useEffect } from "react";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { rootAttributes } from "./settings";
import { registerCoinsWorklet } from "./coins-worklet";
import { mountSpatialTooltips } from "./spatial-tooltip";
import { mountPhaseSync } from "./phase-sync";

const ROOT_ATTRIBUTES = ["data-bui-loader", "data-bui-chips", "data-bui-off"];

function BeautifulChatStyles() {
  const { values, isLoading } = useSettings();
  const { loader, chips, off } = rootAttributes(values ?? {});
  const offList = off.join(" ");

  useEffect(() => {
    // Until settings arrive the CSS defaults apply, which match the setting defaults.
    if (isLoading) return;
    const root = document.documentElement;
    root.setAttribute("data-bui-loader", loader);
    root.setAttribute("data-bui-chips", chips);
    root.setAttribute("data-bui-off", offList);
    return () => ROOT_ATTRIBUTES.forEach((name) => root.removeAttribute(name));
  }, [isLoading, loader, chips, offList]);

  useEffect(() => mountPhaseSync(), []);

  const tooltips = !off.includes("actions");
  useEffect(() => (tooltips ? mountSpatialTooltips() : undefined), [tooltips]);

  // The coins loader paints through a CSS Paint Worklet; until it is registered (or if
  // it can't be) app.css keeps showing the drive loader instead of a blank icon.
  const coins = loader === "coins";
  useEffect(() => {
    if (!coins) return;
    let current = true;
    registerCoinsWorklet().then((ready) => {
      if (current && ready) document.documentElement.setAttribute("data-bui-coins-ready", "");
    });
    return () => {
      current = false;
      document.documentElement.removeAttribute("data-bui-coins-ready");
    };
  }, [coins]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "beautiful-chat-styles", component: BeautifulChatStyles });
});
