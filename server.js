const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_store (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
ensureTable().catch((e) => console.error("DB init error:", e));

app.get("/api/db", async (req, res) => {
  try {
    const r = await pool.query("SELECT data FROM hr_store WHERE id = $1", ["v1"]);
    res.json({ data: r.rows[0] ? r.rows[0].data : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "load_failed" });
  }
});

app.put("/api/db", async (req, res) => {
  try {
    const data = req.body;
    await pool.query(
      `INSERT INTO hr_store (id, data, updated_at) VALUES ('v1', $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [data]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "save_failed" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("HR server listening on port " + PORT);
});
