// Tiny mock backend for the demo — stands in for a real booking API.
// Run: node examples/demo/mock-stays-server.mjs  (listens on :8787)
// Point the manifest at it: STAYS_API_URL=http://localhost:8787
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const query = safeJson(body);
    // Pretend to search; echo the destination back in the results.
    const where = query?.destination ?? "your destination";
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        stays: [
          { id: "azur-01", name: `Hotel Azur — ${where}`, pricePerNight: 118, rating: 4.5 },
          { id: "dunes-02", name: `Dunes Resort — ${where}`, pricePerNight: 149, rating: 4.7 },
        ],
      }),
    );
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
