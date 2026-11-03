import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("mobile app shell", () => {
  it("renders the initial NEXUS welcome screen", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("NEXUS.apk");
    expect(markup).toContain("Fundação pronta para evoluir");
  });
});
