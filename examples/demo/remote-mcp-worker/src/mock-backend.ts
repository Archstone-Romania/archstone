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

// Board types as Amadeus Hotel Search v3 spells them; room wording follows its
// `room.description`. Kept deterministic (hashed from the destination) so the same query
// always returns the same three stays — a demo backend that varied would make every
// `archstone verify` run report drift that never happened.
const BOARD_TYPES: string[] = ["ROOM_ONLY", "BREAKFAST", "HALF_BOARD", "ALL_INCLUSIVE"];
const ROOMS: string[] = [
  "Double Deluxe Premium, sea view",
  "Junior Suite, terrace",
  "Twin Classic, garden view",
  "Family Room, two bedrooms",
];

/** A free-cancellation deadline, as a Hotelbeds-style `cancellationPolicies[].from` date. */
function cancelBy(seed: number): string {
  const day = 1 + (seed % 27);
  const month = 6 + (seed % 3);
  return `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

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
      boardType: BOARD_TYPES[(seed + i * 3) % BOARD_TYPES.length],
      freeCancellationUntil: cancelBy(seed + i * 11),
      roomDescription: ROOMS[(seed + i * 5) % ROOMS.length],
      // Wholesale rate and agency cut — returned here because real accommodation APIs return
      // them beside the public price (Hotelbeds `net`, Amadeus v3 `commission`). The manifest
      // does not map them, so they never reach a model (ADR-0008). Their presence is the point:
      // the control is the mapping allowlist, not the backend's discretion.
      net: Math.round(price * 0.78 * 100) / 100,
      commission: Math.round(price * 0.12 * 100) / 100,
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
