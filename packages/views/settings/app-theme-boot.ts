/**
 * Pre-paint boot snippet for the appearance customization — colors only
 * (accent/background/foreground trio), so a customized theme never flashes
 * the stock look before any bundle executes.
 *
 * Pure string module (no "use client"): the Next.js root layout inlines it
 * via dangerouslySetInnerHTML, and apps/tauri/index.html carries a verbatim
 * copy. The full preset surface pass happens later in initAppTheme()
 * (packages/views/settings/app-theme.ts).
 */

export const APP_THEME_BOOT_SNIPPET = `
(function () {
  try {
    var raw = JSON.parse(localStorage.getItem("lynse-theme-custom") || "{}");
    var t = localStorage.getItem("theme");
    var dark;
    if (t === "dark" || t === "light") dark = t === "dark";
    else dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var canonical = dark
      ? { a: "#e0b15c", b: "#17181b", f: "#f5f3ee" }
      : { a: "#5f67d8", b: "#fafafa", f: "#202023" };
    // Authored preset trios — mirror APP_THEME_PRESETS in app-theme.ts.
    var trios = {
      linear: { light: { a: "#5e6ad2", b: "#fcfcfd", f: "#1b1b1b" }, dark: { a: "#5e6ad2", b: "#08090a", f: "#f7f8f8" } },
      notion: { light: { a: "#2383e2", b: "#ffffff", f: "#37352f" }, dark: { a: "#2383e2", b: "#191919", f: "#d4d4d4" } },
    };
    var trio = trios[raw.preset] ? trios[raw.preset][dark ? "dark" : "light"] : canonical;
    var a = raw.accent || trio.a;
    var st = document.documentElement.style;
    ["--primary", "--ring", "--brand", "--info", "--waveform-active", "--sidebar-primary", "--sidebar-ring", "--chart-1"].forEach(function (v) { st.setProperty(v, a); });
    var lin = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    var hx = a.slice(1); if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    var lum = 0.2126 * lin(parseInt(hx.slice(0, 2), 16)) + 0.7152 * lin(parseInt(hx.slice(2, 4), 16)) + 0.0722 * lin(parseInt(hx.slice(4, 6), 16));
    st.setProperty("--primary-foreground", lum > 0.45 ? "#15110a" : "#ffffff");
    if (trio !== canonical) {
      st.setProperty("--background", trio.b);
      ["--foreground", "--card-foreground", "--popover-foreground", "--sidebar-foreground", "--secondary-foreground", "--accent-foreground"].forEach(function (v) { st.setProperty(v, trio.f); });
    }
  } catch (e) {}
})();
`;
