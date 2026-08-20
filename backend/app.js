// nodejs + express js backend, save all data to RAM. super simple routes for roblox executor client to send data and super simple for frontend to read no key no verify at all
// no security at all
// have a reset route. account distinct by username, so client send username and list of data pets. that is all client send.
//
// Routes:
//   POST /api/report   { username, pets: [...] }  <- roblox executor client (every 5s)
//   GET  /api/accounts                          -> all accounts + their pet lists
//   GET  /api/thumb?assetIds=1,2,3              -> proxy: assetId -> Roblox thumbnail URL
//   GET  /api/thumbimg?assetId=1                -> proxy: returns the thumbnail image BYTES
//   POST /api/reset                             -> wipe all data
//   GET  /                                      -> serves ../frontend/index.html
//
// Run:  node app.js   (default 0.0.0.0:3030, override with PORT env)

const express = require("express");
const path = require("path");
const http = require("http");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---------- RAM store ----------
// accounts: username (lowercased) -> {
//   username, pets: [...], petCount, totalPerSecond,
//   firstSeen, lastSeen, reports
// }
const accounts = new Map();

function sanitizePet(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    // keep it flat & serializable: primitives + arrays of primitives
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      (Array.isArray(v) && v.every((x) => x === null || typeof x === "string" || typeof x === "number"))
    ) {
      out[k] = v;
    }
  }
  return out;
}

function upsertAccount(username, pets) {
  const key = String(username).toLowerCase();
  const now = Date.now();
  let acc = accounts.get(key);
  if (!acc) {
    acc = { username: String(username), firstSeen: now, reports: 0 };
    accounts.set(key, acc);
  }
  const cleanPets = (Array.isArray(pets) ? pets : []).map(sanitizePet).filter(Boolean);
  acc.pets = cleanPets;
  acc.petCount = cleanPets.length;
  acc.totalPerSecond = cleanPets.reduce(
    (sum, p) => sum + (typeof p.perSecond === "number" ? p.perSecond : 0),
    0
  );
  acc.lastSeen = now;
  acc.reports += 1;
  return acc;
}

// ---------- routes ----------
// client -> backend: report pet data
app.post("/api/report", (req, res) => {
  const { username, pets } = req.body || {};
  if (!username || typeof username !== "string") {
    return res.status(400).json({ ok: false, error: "username (string) required" });
  }
  if (!Array.isArray(pets)) {
    return res.status(400).json({ ok: false, error: "pets (array) required" });
  }
  const acc = upsertAccount(username, pets);
  res.json({ ok: true, petCount: acc.petCount });
});

// frontend -> backend: read everything
app.get("/api/accounts", (req, res) => {
  const list = [...accounts.values()].map((a) => ({
    username: a.username,
    petCount: a.petCount,
    totalPerSecond: a.totalPerSecond,
    firstSeen: a.firstSeen,
    lastSeen: a.lastSeen,
    reports: a.reports,
    online: Date.now() - a.lastSeen < 15000, // missed ~3 reports = offline
    pets: a.pets,
  }));
  res.json({ ok: true, count: list.length, accounts: list });
});

// frontend -> backend: resolve rbxassetid(s) to Roblox thumbnail image URLs.
// The thumbnails.roblox.com API has no CORS headers, so the browser (on Vercel)
// can't call it directly. We proxy it server-side (no CORS restriction here) and
// return { [assetId]: imageUrl }. The returned *.rbxcdn.com URLs load fine in <img>.
app.get("/api/thumb", async (req, res) => {
  const raw = String(req.query.assetIds || "");
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,20}$/.test(s))
    .slice(0, 100); // cap to avoid abuse
  if (!ids.length) {
    return res.json({ ok: true, images: {} });
  }
  try {
    const url =
      "https://thumbnails.roblox.com/v1/assets?assetIds=" +
      ids.join(",") +
      "&size=420x420&format=Png";
    const r = await fetch(url);
    const j = await r.json();
    const images = {};
    for (const d of j.data || []) {
      if (d && d.targetId != null && d.imageUrl) {
        images[String(d.targetId)] = d.imageUrl;
      }
    }
    res.json({ ok: true, images });
  } catch (e) {
    res.status(502).json({ ok: false, error: "thumbnail proxy failed: " + e.message });
  }
});

// frontend -> backend: return the actual thumbnail image BYTES for one assetId.
// rbxcdn.com has no CORS headers, so the browser (on Vercel) can't fetch the bytes
// directly. We proxy server-side and return the raw image; the frontend stores it as
// an in-RAM blob URL so it loads instantly and consistently everywhere.
app.get("/api/thumbimg", async (req, res) => {
  const id = String(req.query.assetId || "").trim();
  if (!/^\d{1,20}$/.test(id)) {
    return res.status(400).json({ ok: false, error: "assetId (numeric) required" });
  }
  try {
    const meta = await fetch(
      "https://thumbnails.roblox.com/v1/assets?assetIds=" + id + "&size=420x420&format=Png"
    );
    const j = await meta.json();
    const d = (j.data || [])[0];
    if (!d || !d.imageUrl) {
      return res.status(404).json({ ok: false, error: "no thumbnail for assetId " + id });
    }
    const img = await fetch(d.imageUrl);
    const buf = Buffer.from(await img.arrayBuffer());
    res.setHeader("Content-Type", img.headers.get("content-type") || "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.send(buf);
  } catch (e) {
    res.status(502).json({ ok: false, error: "thumbimg failed: " + e.message });
  }
});

// wipe all data
app.post("/api/reset", (req, res) => {
  accounts.clear();
  res.json({ ok: true });
});

// serve the frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// ---------- start ----------
const PORT = process.env.PORT || 3030;
const HOST = process.env.HOST || "0.0.0.0";
http.createServer(app).listen(PORT, HOST, () => {
  console.log(`[trackstat] backend listening on http://${HOST}:${PORT}`);
  console.log(`[trackstat] frontend: http://${HOST}:${PORT}/`);
  console.log(`[trackstat] client endpoint: http://${HOST}:${PORT}/api/report`);
});