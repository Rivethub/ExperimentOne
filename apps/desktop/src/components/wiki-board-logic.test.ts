import { describe, expect, it } from "vitest";
import { entityTypeFromTags, topicSlugFromWikiPage, topicWikiPageId } from "./wiki-board-logic";

describe("topicWikiPageId", () => {
  it("maps typed entities through type: tags", () => {
    expect(topicWikiPageId("rivet", "entity:alice", "entity", ["entity", "type:person"])).toBe(
      "rivet/entities/person/alice",
    );
  });

  it("maps untyped entities to entities/{slug}", () => {
    expect(topicWikiPageId("rivet", "entity:alice", "entity", ["entity"])).toBe(
      "rivet/entities/alice",
    );
  });
});

describe("topicSlugFromWikiPage", () => {
  it("returns entity: prefix for typed and untyped entity pages", () => {
    expect(topicSlugFromWikiPage({ relative_path: "entities/person/alice.md" })).toBe(
      "entity:alice",
    );
    expect(topicSlugFromWikiPage({ relative_path: "entities/alice.md" })).toBe("entity:alice");
  });

  it("keeps plain topic slugs", () => {
    expect(topicSlugFromWikiPage({ relative_path: "topics/oauth-pkce.md" })).toBe("oauth-pkce");
  });
});

describe("entityTypeFromTags", () => {
  it("reads the type: tag", () => {
    expect(entityTypeFromTags(["entity", "type:person"])).toBe("person");
    expect(entityTypeFromTags(["entity"])).toBeNull();
  });
});
