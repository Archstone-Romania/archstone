// Tiny mock backend for the demo — stands in for a real booking API.
// Run: node examples/demo/mock-stays-server.mjs  (listens on :8787)
// Point the manifest at it: STAYS_API_URL=http://localhost:8787
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);

// Ported to ./remote-mcp-worker/src/mock-backend.ts — keep the two in sync. Results are
// hashed from the destination string, not random, so the same query always returns the
// same three stays.
const NAMES = [
  "Hotel Azur", "Dunes Resort", "The Olive Court", "Casa del Sol", "Northgate Inn",
  "Riverside Lodge", "Marina View", "The Old Quarter Hotel", "Cypress Suites", "Harbor House",
];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function buildStays(where) {
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

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const query = safeJson(body);
    // Pretend to search; echo the destination back in the results.
    const where = query?.destination ?? "your destination";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ stays: buildStays(where) }));
  });
});

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

server.listen(PORT, () => console.error(`mock stays API on http://localhost:${PORT}`));
