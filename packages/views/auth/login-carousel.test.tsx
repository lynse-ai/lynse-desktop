/* @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import { initI18n } from "@lynse/core/i18n";
import { RESOURCES } from "../locales";
import { LoginCarousel } from "./login-carousel";

const slides = Array.from({ length: 3 }, () => ({
  src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  title: "Fallback title",
  description: "Fallback description",
}));

afterEach(cleanup);

describe("login carousel localization", () => {
  it("updates all slide captions when the application language changes", async () => {
    initI18n({ locale: "en", resources: RESOURCES });
    for (const [locale, resource] of Object.entries(RESOURCES)) {
      i18next.addResourceBundle(locale, "translation", resource.translation, true, true);
    }
    await i18next.changeLanguage("en");
    render(<LoginCarousel slides={slides} />);
    for (const locale of ["en", "zh-Hans", "zh-Hant", "ja", "ko"] as const) {
      await act(async () => { await i18next.changeLanguage(locale); });
      const auth = RESOURCES[locale].translation.auth;
      for (const text of [auth.login_carousel_1_title, auth.login_carousel_1_description,
        auth.login_carousel_2_title, auth.login_carousel_2_description,
        auth.login_carousel_3_title, auth.login_carousel_3_description]) {
        expect(screen.getByText(text)).toBeTruthy();
      }
    }
    expect(screen.queryByText("Fallback title")).toBeNull();
  });
});
