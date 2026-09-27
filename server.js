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

// 저장 충돌 방지: 클라이언트가 불러온 판(_rev)과 서버의 현재 판이 같을 때만 저장한다.
// (다른 창·옛 화면이 먼저 저장된 최신 데이터를 덮어쓰지 못하게)
app.put("/api/db", async (req, res) => {
  const client = await pool.connect();
  try {
    const data = req.body || {};
    await client.query("BEGIN");
    const cur = await client.query("SELECT data FROM hr_store WHERE id = $1 FOR UPDATE", ["v1"]);
    const curRev = cur.rows[0] && cur.rows[0].data ? Number(cur.rows[0].data._rev || 0) : 0;
    const baseRev = Number(data._rev || 0);
    if (cur.rows[0] && baseRev !== curRev) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "conflict", rev: curRev });
    }
    const next = curRev + 1;
    data._rev = next;
    await client.query(
      `INSERT INTO hr_store (id, data, updated_at) VALUES ('v1', $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [data]
    );
    await client.query("COMMIT");
    res.json({ ok: true, rev: next });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error(e);
    res.status(500).json({ error: "save_failed" });
  } finally {
    client.release();
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("HR server listening on port " + PORT);
});
