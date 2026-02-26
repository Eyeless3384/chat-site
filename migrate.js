const path = require("path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

(async () => {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "chat.db");

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // 1) adicionar coluna (se não existir)
  try {
    await db.exec(`ALTER TABLE messages ADD COLUMN room_slug TEXT;`);
    console.log("Coluna room_slug adicionada.");
  } catch (e) {
    // se já existir, ignora
    console.log("ALTER TABLE ignorado:", e.message);
  }

  // 2) preencher mensagens antigas com 'geral'
  await db.run(`UPDATE messages SET room_slug = 'geral' WHERE room_slug IS NULL;`);
  console.log("Mensagens antigas atribuídas à sala 'geral'.");

  // 3) criar índice
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_slug, id);`);
  console.log("Índice criado/confirmado.");

  // 4) garantir tabela rooms e sala geral
  await db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  await db.run(
    `INSERT OR IGNORE INTO rooms (slug, name, created_at) VALUES ('geral', 'geral', ?)`,
    Date.now()
  );
  console.log("Tabela rooms ok + sala geral ok.");

  await db.close();
  console.log("Migração concluída ✅");
})().catch((err) => {
  console.error("Falha na migração:", err);
  process.exit(1);
});