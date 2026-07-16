// Ported from ../mock-stays-server.mjs — identical canned response shape, served as a
// Workers `fetch` handler instead of a Node `http.Server`. Stands in for a real booking API.
//
// Results are generated from a hash of the destination string, not random — same query,
// same three stays, every time, so the demo is reproducible and curl-able while still
// looking like real search results instead of two hardcoded hotels repeated for every city.

interface StaySearchInput {
  destination?: string;
}

const NAMES = [
  "Hotel Azur", "Dunes Resort", "The Olive Court", "Casa del Sol", "Northgate Inn",
  "Riverside Lodge", "Marina View", "The Old Quarter Hotel", "Cypress Suites", "Harbor House",
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function buildStays(where: string) {
  const seed = hash(where.trim().toLowerCase());
  const stays = Array.from({ length: 3 }, (_, i) => {
    const nameIdx = (seed + i * 7) % NAMES.length;
    const price = 95 + ((seed + i * 53) % 245);
    const rating = Math.round((3.7 + ((seed + i * 17) % 13) / 10) * 10) / 10;
    return {
      id: `stay-${nameIdx}-${i}`,
      name: `${NAMES[nameIdx]} — ${where}`,
      location: where,
      pricePerNight: price,
      rating,
    };
  });
  return stays.sort((a, b) => a.pricePerNight - b.pricePerNight);
}

export async function mockStaysResponse(request: Request): Promise<Response> {
  const query = await safeJson(request);
  const where = query?.destination ?? "your destination";
  return Response.json({ stays: buildStays(where) });
}

async function safeJson(request: Request): Promise<StaySearchInput | undefined> {
  try {
    return (await request.json()) as StaySearchInput;
  } catch {
    return undefined;
  }
}
