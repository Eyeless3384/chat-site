const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL não configurado.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- CONFIG ----------
const HISTORY_LIMIT = 50;
const MAX_MESSAGES = 1000;

// ---------- DATABASE ----------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      slug TEXT PRIMARY KEY,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      room_slug TEXT NOT NULL,
      user_display TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    INSERT INTO rooms (slug, created_at)
    VALUES ('geral', $1)
    ON CONFLICT (slug) DO NOTHING
  `, [Date.now()]);
}

async function saveMessage(room, user, text) {
  const created_at = Date.now();

  await pool.query(
    `INSERT INTO messages (room_slug, user_display, text, created_at)
     VALUES ($1,$2,$3,$4)`,
    [room, user, text, created_at]
  );

  await pool.query(
    `DELETE FROM messages
     WHERE room_slug=$1
     AND id NOT IN (
       SELECT id FROM messages
       WHERE room_slug=$1
       ORDER BY id DESC
       LIMIT $2
     )`,
    [room, MAX_MESSAGES]
  );

  return { roomSlug: room, user, text, created_at };
}

async function loadHistory(room) {
  const { rows } = await pool.query(
    `SELECT user_display AS user, text, created_at
     FROM messages
     WHERE room_slug=$1
     ORDER BY id DESC
     LIMIT $2`,
    [room, HISTORY_LIMIT]
  );
  return rows.reverse();
}

// ---------- SOCKET ----------
const presence = new Map();

io.on("connection", (socket) => {

  socket.data.username = "Anônimo";
  socket.data.room = "geral";

  socket.on("join_room", async ({ roomSlug, username }) => {
    const room = roomSlug || "geral";
    const user = (username || "Anônimo").slice(0, 24);

    socket.data.username = user;
    socket.data.room = room;

    socket.join(room);

    if (!presence.has(room)) presence.set(room, new Set());
    presence.get(room).add(user);

    io.to(room).emit("presence", {
      roomSlug: room,
      users: Array.from(presence.get(room)),
      count: presence.get(room).size
    });

    socket.emit("history", {
      roomSlug: room,
      messages: await loadHistory(room)
    });
  });

  socket.on("chat_message", async ({ text }) => {
    const room = socket.data.room;
    const user = socket.data.username;
    if (!text || !text.trim()) return;

    if (text.startsWith("/admin ")) {
      const token = text.split(" ")[1];
      if (token === ADMIN_TOKEN) {
        socket.emit("system", { roomSlug: room, text: "Admin autenticado ✅" });
      } else {
        socket.emit("system", { roomSlug: room, text: "Token inválido ❌" });
      }
      return;
    }

    const saved = await saveMessage(room, user, text);
    io.to(room).emit("chat_message", saved);
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    const user = socket.data.username;

    if (presence.has(room)) {
      presence.get(room).delete(user);
      io.to(room).emit("presence", {
        roomSlug: room,
        users: Array.from(presence.get(room)),
        count: presence.get(room).size
      });
    }
  });
});

// ---------- START ----------
(async () => {
  await initDB();
  server.listen(PORT, () => {
    console.log("Servidor online na porta", PORT);
  });
})();