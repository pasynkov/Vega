import { describe, expect, it } from "vitest";
import { slug } from "../../src/domains/notes/notes-storage.service";

describe("slug()", () => {
  it("keeps cyrillic letters and converts whitespace to hyphens", () => {
    expect(slug("идея проекта")).toBe("идея-проекта");
    expect(slug("Идея   ПРОЕКТА")).toBe("идея-проекта");
  });

  it("keeps latin letters/digits and drops everything else", () => {
    expect(slug("Buy 2L milk!")).toBe("buy-2l-milk");
    expect(slug("v1.0.0-release")).toBe("v100-release");
  });

  it("falls back to 'note' when input is punctuation only", () => {
    expect(slug("!!!")).toBe("note");
    expect(slug("   ")).toBe("note");
    expect(slug("---")).toBe("note");
  });

  it("clamps to 60 UTF-16 code units and trims trailing hyphens", () => {
    const long = "a".repeat(80);
    expect(slug(long).length).toBe(60);
    expect(slug("очень-длинное-имя-".repeat(10)).length).toBeLessThanOrEqual(60);
  });

  it("collapses internal hyphen runs", () => {
    expect(slug("a---b")).toBe("a-b");
    expect(slug("--hello--world--")).toBe("hello-world");
  });
});
