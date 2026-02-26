// server.js — Produto Chat (Fly.io + SQLite + Rooms + Admin + Anti-spam)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.static(path.join(__dirname, "public")));

// ---------- Config ----------
const PORT = process.env.PORT || 3000;

// Em produção (Fly): set DB_PATH=/data/chat.db e monte volume em /data
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "chat.db");

// Fly secrets: fly secrets set ADMIN_TOKEN="..."
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const HISTORY_ON_JOIN = 50;
const MAX_MESSAGES_PER_ROOM = 1000;

const MAX_ROOMS = 20;
const DEFAULT_ROOMS = [
  { slug: "geral", name: "geral" },
  { slug: "off-topic", name: "off-topic" },
  { slug: "spoilers", name: "spoilers" },
];

const AntiSpamMode = { OFF: "off", ON: "on", LOCKDOWN: "lockdown" };
const RATE_RULES = {
  off: { windowMs: 10_000, maxMsgs: 9999, cooldownMs: 0 },
  on: { windowMs: 10_000, maxMsgs: 5, cooldownMs: 5_000 },
  lockdown: { windowMs: 10_000, maxMsgs: 2, cooldownMs: 15_000 },
};
let antiSpamMode = AntiSpamMode.ON;

// ---------- Utils ----------
const now = () => Date.now();

function sanitizeName(name) {
  let n = (name ?? "").toString().trim();
  if (!n) n = "Anônimo";
  n = n.replace(/\s+/g, " ");
  if (n.length > 24) n = n.slice(0, 24);
  return n;
}

function sanitizeText(text) {
  let t = (text ?? "").toString().trim();
  if (!t) return "";
  if (t.length > 800) t = t.slice(0, 800);
  return t;
}

function slugifyRoom(input) {
  let s = (input ?? "").toString().trim().toLowerCase();
  s = s.replace(/\s+/g, "-");
  s = s.replace(/[^a-z0-9\-_]/g, "");
  if (s.length < 2) return "";
  if (s.length > 20) s = s.slice(0, 20);
  s = s.replace(/^-+/, "").replace(/-+$/, "");
  return s;
}

function parseCommand(text) {
  if (!text.startsWith("/")) return null;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].slice(1).toLowerCase();
  const args = parts.slice(1);
  return { cmd, args };
}

function ensureSocketData(socket) {
  socket.data = socket.data || {};
  if (!socket.data.rate) {
    socket.data.rate = { windowStart: now(), count: 0, blockedUntil: 0 };
  }
  if (typeof socket.data.isAdmin !== "boolean") socket.data.isAdmin = false;
}

function checkRateLimit(socket) {
  ensureSocketData(socket);
  const rules = RATE_RULES[antiSpamMode] || RATE_RULES.on;
  const r = socket.data.rate;
  const ts = now();

  if (r.blockedUntil && ts < r.blockedUntil) {
    return { ok: false, retryInMs: r.blockedUntil - ts };
  }
  if (ts - r.windowStart > rules.windowMs) {
    r.windowStart = ts;
    r.count = 0;
  }
  r.count += 1;

  if (r.count > rules.maxMsgs) {
    if (rules.cooldownMs > 0) r.blockedUntil = ts + rules.cooldownMs;
    return { ok: false, retryInMs: rules.cooldownMs || rules.windowMs };
  }
  return { ok: true, retryInMs: 0 };
}

function isAdmin(socket) {
  ensureSocketData(socket);
  return socket.data.isAdmin === true;
}

function setAdmin(socket, value) {
  ensureSocketData(socket);
  socket.data.isAdmin = value;
}

// ---------- Presence + Typing (memory) ----------
/**
 * presence: roomSlug -> Map(socketId -> username)
 * typing: roomSlug -> Map(username -> lastSeenTs)
 */
const presence = new Map();
const typing = new Map();

function addUserToRoom(roomSlug, socketId, username) {
  if (!presence.has(roomSlug)) presence.set(roomSlug, new Map());
  presence.get(roomSlug).set(socketId, username);
}

function removeUserFromRoom(roomSlug, socketId) {
  const m = presence.get(roomSlug);
  if (!m) return;
  m.delete(socketId);
  if (m.size === 0) presence.delete(roomSlug);
}

function getUsersInRoom(roomSlug) {
  const m = presence.get(roomSlug);
  if (!m) return [];
  return Array.from(new Set(m.values())).sort((a, b) => a.localeCompare(b));
}

function emitPresence(roomSlug) {
  const users = getUsersInRoom(roomSlug);
  io.to(roomSlug).emit("presence", { roomSlug, users, count: users.length });
}

function setTyping(roomSlug, username) {
  if (!typing.has(roomSlug)) typing.set(roomSlug, new Map());
  typing.get(roomSlug).set(username, now());
}

function clearTyping(roomSlug, username) {
  const m = typing.get(roomSlug);
  if (!m) return;
  m.delete(username);
  if (m.size === 0) typing.delete(roomSlug);
}

function getTypingUsers(roomSlug) {
  const m = typing.get(roomSlug);
  if (!m) return [];
  const ts = now();
  for (const [u, last] of m.entries()) {
    if (ts - last > 3000) m.delete(u);
  }
  if (m.size === 0) typing.delete(roomSlug);
  return Array.from(m.keys()).sort((a, b) => a.localeCompare(b));
}

function emitTyping(roomSlug) {
  io.to(roomSlug).emit("typing", { roomSlug, usersTyping: getTypingUsers(roomSlug) });
}

function emitSystem(roomSlug, text) {
  io.to(roomSlug).emit("system", { roomSlug, text });
}

function emitError(socket, message) {
  socket.emit("error_msg", { message });
}

// ---------- DB ----------
async function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_slug TEXT NOT NULL,
      user_display TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_slug, id);`);

  for (const r of DEFAULT_ROOMS) {
    await db.run(
      `INSERT OR IGNORE INTO rooms (slug, name, created_at) VALUES (?, ?, ?)`,
      r.slug,
      r.name,
      now()
    );
  }

  return db;
}

async function listRooms(db) {
  return db.all(
    `SELECT slug, name FROM rooms ORDER BY created_at ASC LIMIT ?`,
    MAX_ROOMS
  );
}

async function ensureRoom(db, slug) {
  const row = await db.get(`SELECT slug FROM rooms WHERE slug = ?`, slug);
  return !!row;
}

async function createRoom(db, slug) {
  await db.run(
    `INSERT INTO rooms (slug, name, created_at) VALUES (?, ?, ?)`,
    slug,
    slug,
    now()
  );
}

async function loadHistory(db, roomSlug) {
  const rows = await db.all(
    `SELECT user_display as user, text, created_at
     FROM messages
     WHERE room_slug = ?
     ORDER BY id DESC
     LIMIT ?`,
    roomSlug,
    HISTORY_ON_JOIN
  );
  return rows.reverse();
}

async function saveMessage(db, roomSlug, user, text) {
  const created_at = now();

  await db.run(
    `INSERT INTO messages (room_slug, user_display, text, created_at)
     VALUES (?, ?, ?, ?)`,
    roomSlug,
    user,
    text,
    created_at
  );

  // prune por sala
  await db.run(
    `
    DELETE FROM messages
    WHERE room_slug = ?
      AND id NOT IN (
        SELECT id FROM messages
        WHERE room_slug = ?
        ORDER BY id DESC
        LIMIT ?
      )
    `,
    roomSlug,
    roomSlug,
    MAX_MESSAGES_PER_ROOM
  );

  return { user, text, created_at };
}

// ---------- Main ----------
(async () => {
  const db = await initDb();

  async function broadcastRooms() {
    io.emit("room_list", await listRooms(db));
  }

  io.on("connection", async (socket) => {
    ensureSocketData(socket);
    socket.data.username = "Anônimo";
    socket.data.roomSlug = "";

    socket.emit("room_list", await listRooms(db));
    socket.emit("antispam_status", { mode: antiSpamMode });

    socket.on("join_room", async ({ roomSlug, username }) => {
      const u = sanitizeName(username);
      const slug = slugifyRoom(roomSlug) || "geral";

      if (!(await ensureRoom(db, slug))) {
        emitError(socket, "Sala não existe.");
        return;
      }

      // sair da sala anterior
      if (socket.data.roomSlug) {
        const prev = socket.data.roomSlug;
        socket.leave(prev);
        removeUserFromRoom(prev, socket.id);
        clearTyping(prev, socket.data.username);
        emitPresence(prev);
        emitTyping(prev);
        emitSystem(prev, `${socket.data.username} saiu 🔴`);
      }

      socket.data.username = u;
      socket.data.roomSlug = slug;

      socket.join(slug);
      addUserToRoom(slug, socket.id, u);

      emitPresence(slug);
      emitSystem(slug, `${u} entrou 🟢`);

      socket.emit("history", { roomSlug: slug, messages: await loadHistory(db, slug) });
      emitTyping(slug);
    });

    socket.on("create_room", async ({ roomName }) => {
      const slug = slugifyRoom(roomName);
      if (!slug) {
        emitError(socket, "Nome de sala inválido. Use letras/números/-/_ (2 a 20).");
        return;
      }

      const rooms = await listRooms(db);
      if (rooms.length >= MAX_ROOMS) {
        emitError(socket, `Limite de salas atingido (${MAX_ROOMS}).`);
        return;
      }

      if (!(await ensureRoom(db, slug))) {
        await createRoom(db, slug);
        await broadcastRooms();
      }

      socket.emit("room_created", { roomSlug: slug });
    });

    socket.on("typing", ({ isTyping }) => {
      const slug = socket.data.roomSlug;
      if (!slug) return;
      const u = sanitizeName(socket.data.username);

      if (isTyping) setTyping(slug, u);
      else clearTyping(slug, u);

      emitTyping(slug);
    });

    socket.on("chat_message", async ({ text }) => {
      const slug = socket.data.roomSlug || "geral";
      const u = sanitizeName(socket.data.username);
      const t = sanitizeText(text);

      if (!t) return;

      // comandos
      const cmd = parseCommand(t);
      if (cmd) {
        const { cmd: c, args } = cmd;

        if (c === "admin") {
          const token = (args[0] ?? "").toString();
          if (!ADMIN_TOKEN) {
            emitError(socket, "ADMIN_TOKEN não configurado no servidor.");
            return;
          }
          if (token === ADMIN_TOKEN) {
            setAdmin(socket, true);
            socket.emit("admin_status", { ok: true });
            emitSystem(slug, `${u} virou admin ✅`);
          } else {
            setAdmin(socket, false);
            socket.emit("admin_status", { ok: false });
            emitError(socket, "Token admin inválido.");
          }
          return;
        }

        if (c === "antispam") {
          if (!isAdmin(socket)) {
            emitError(socket, "Somente admin pode mudar anti-spam.");
            return;
          }
          const mode = (args[0] ?? "").toString().toLowerCase();
          if (![AntiSpamMode.OFF, AntiSpamMode.ON, AntiSpamMode.LOCKDOWN].includes(mode)) {
            emitError(socket, "Use: /antispam off | on | lockdown");
            return;
          }
          antiSpamMode = mode;
          io.emit("antispam_status", { mode: antiSpamMode });
          emitSystem(slug, `Anti-spam: ${antiSpamMode.toUpperCase()} 🛡️`);
          return;
        }

        if (c === "room") {
          const wanted = slugifyRoom(args.join(" "));
          if (!wanted) {
            emitError(socket, "Use: /room nome-da-sala");
            return;
          }

          const rooms = await listRooms(db);
          if (!rooms.find((r) => r.slug === wanted)) {
            if (rooms.length >= MAX_ROOMS) {
              emitError(socket, `Limite de salas atingido (${MAX_ROOMS}).`);
              return;
            }
            await createRoom(db, wanted);
            await broadcastRooms();
          }

          socket.emit("room_created", { roomSlug: wanted });
          // client vai chamar join_room
          return;
        }

        emitError(socket, "Comando desconhecido.");
        return;
      }

      // anti-spam
      const rate = checkRateLimit(socket);
      if (!rate.ok) {
        emitError(socket, `Calma 😅 tente novamente em ${Math.ceil(rate.retryInMs / 1000)}s`);
        return;
      }

      const saved = await saveMessage(db, slug, u, t);
      io.to(slug).emit("chat_message", { roomSlug: slug, ...saved });
    });

    socket.on("disconnect", () => {
      const slug = socket.data.roomSlug;
      if (!slug) return;

      removeUserFromRoom(slug, socket.id);
      clearTyping(slug, socket.data.username);
      emitPresence(slug);
      emitTyping(slug);
      emitSystem(slug, `${socket.data.username} saiu 🔴`);
    });
  });

  server.listen(PORT, () => {
    console.log("Servidor rodando na porta", PORT);
    console.log("DB_PATH:", DB_PATH);
    console.log("Anti-spam:", antiSpamMode);
  });
})().catch((err) => {
  console.error("Falha ao iniciar:", err);
  process.exit(1);
});