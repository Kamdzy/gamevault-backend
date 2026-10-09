/**
 * Fork contract: the provider title search strips `[...]` edition tags.
 *
 * Upstream added the strip in d8edecb ("remove edition tags in search") and
 * then dropped it by accident in ee7f0a6, a strict-TypeScript refactor whose
 * message mentions no behaviour change. Without it a filename-derived title
 * like `Forza Horizon 6 [Multiplayer]` reaches IGDB verbatim and finds
 * nothing - and the fork's search-miss cache then remembers that "no match"
 * for TTL_IN_DAYS. A merge that rewrites getBestMatch() will drop the strip
 * again without a conflict; this test is the tripwire.
 */
import { MetadataProvider } from "./modules/metadata/providers/abstract.metadata-provider.service.js";

class RecordingProvider extends MetadataProvider {
  override slug = "recording";
  override name = "Recording";
  override priority = 1;
  override enabled = true;
  readonly queries: string[] = [];

  override async search(query: string) {
    this.queries.push(query);
    return [
      {
        provider_slug: this.slug,
        provider_data_id: "1",
        title: "Forza Horizon 6",
      },
    ] as any;
  }

  override async getByProviderDataIdOrFail(): Promise<any> {
    throw new Error("not used");
  }
}

function provider(): RecordingProvider {
  return new (RecordingProvider as any)(...Array(7).fill(undefined));
}

describe("Fork delta: provider search strips edition tags", () => {
  it.each([
    ["Forza Horizon 6 [Multiplayer]", "Forza Horizon 6"],
    [
      "Silent Hill 2 - Remake [Digital Deluxe Edition]",
      "Silent Hill 2 - Remake",
    ],
    ["NARUTO X BORUTO [Ultimate Edition] [Multiplayer]", "NARUTO X BORUTO"],
    ["The Sims 4 [Deluxe Edition] [Multiplayer]", "The Sims 4"],
    ["Brotato", "Brotato"],
  ])("searches %j as %j", async (title, expected) => {
    const p = provider();
    await p.getBestMatch({ title } as any);
    expect(p.queries).toEqual([expected]);
  });

  it("collapses the double space a mid-title tag leaves behind", async () => {
    const p = provider();
    await p.getBestMatch({
      title: "Kimi ga Nozomu Eien [Enhanced Edition] Latest",
    } as any);
    expect(p.queries).toEqual(["Kimi ga Nozomu Eien Latest"]);
  });

  it("leaves a single space between two tags in the middle of a title", async () => {
    const p = provider();
    await p.getBestMatch({ title: "Foo [Deluxe] [Multiplayer] Bar" } as any);
    expect(p.queries).toEqual(["Foo Bar"]);
  });

  it("strips nested tags without leaving a stray bracket", async () => {
    const p = provider();
    await p.getBestMatch({ title: "Foo [Edition [Remastered]] Bar" } as any);
    expect(p.queries).toEqual(["Foo Bar"]);
  });
});
