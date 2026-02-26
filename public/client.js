const socket = io();

const elSidebar = document.getElementById("sidebar");
const elRooms = document.getElementById("rooms");
const elChat = document.getElementById("chat");
const elForm = document.getElementById("form");
const elInput = document.getElementById("input");

const elRoomName = document.getElementById("roomName");
const elTyping = document.getElementById("typingLine");

const elOnlineBtn = document.getElementById("onlineBtn");
const elOnlineCount = document.getElementById("onlineCount");
const elOnlinePanel = document.getElementById("onlinePanel");
const elOnlineList = document.getElementById("onlineList");
const elOverlay = document.getElementById("overlay");
const elClosePanel = document.getElementById("closePanel");

const elToggleRooms = document.getElementById("toggleRooms");
const elNewRoomBtn = document.getElementById("newRoomBtn");

const elMeAvatar = document.getElementById("meAvatar");
const elMeName = document.getElementById("meName");

const elNewBelow = document.getElementById("newBelow");
const elJumpBtn = document.getElementById("jumpBtn");

let username = prompt("Digite seu nome:") || "Anônimo";
username = username.trim().slice(0, 24) || "Anônimo";

let currentRoom = "geral";
let rooms = [];
let onlineUsers = [];
let typingUsers = [];
let unseenCount = 0;

// ---------- Utils ----------
function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 70% 55%)`;
}

function initial(str) {
  const s = (str || "?").trim();
  return s ? s[0].toUpperCase() : "?";
}

function fmtTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function isNearBottom() {
  const threshold = 140;
  return elChat.scrollHeight - elChat.scrollTop - elChat.clientHeight < threshold;
}

function scrollToBottom() {
  elChat.scrollTop = elChat.scrollHeight;
}

function setUnseen(count) {
  unseenCount = count;
  if (unseenCount > 0) {
    elJumpBtn.textContent = `⬇ ${unseenCount} nova(s)`;
    elNewBelow.hidden = false;
  } else {
    elNewBelow.hidden = true;
  }
}

function clearChat() {
  elChat.innerHTML = "";
  setUnseen(0);
}

// ---------- Sidebar ----------
function closeSidebar() {
  elSidebar.classList.add("closed");
}
function toggleSidebar() {
  elSidebar.classList.toggle("closed");
}
if (window.matchMedia("(max-width: 860px)").matches) closeSidebar();
elToggleRooms.addEventListener("click", toggleSidebar);

// ---------- Online panel (display-based, 100% garantido) ----------
function openOnline() {
  elOverlay.style.display = "block";
  elOnlinePanel.style.display = "flex";
  renderOnlineList();
}
function closeOnline() {
  elOverlay.style.display = "none";
  elOnlinePanel.style.display = "none";
}

// Estado inicial: fechado
closeOnline();

elOnlineBtn.addEventListener("click", (e) => {
  e.preventDefault();
  openOnline();
});

elClosePanel.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeOnline();
});

elOverlay.addEventListener("click", (e) => {
  e.preventDefault();
  closeOnline();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOnline();
});

// ---------- Render ----------
function renderRooms() {
  elRooms.innerHTML = "";
  for (const r of rooms) {
    const row = document.createElement("div");
    row.className = "roomItem" + (r.slug === currentRoom ? " active" : "");

    const dot = document.createElement("div");
    dot.className = "roomDot";

    const label = document.createElement("div");
    label.textContent = "#" + r.slug;

    row.appendChild(dot);
    row.appendChild(label);

    row.addEventListener("click", () => {
      joinRoom(r.slug);
      if (window.matchMedia("(max-width: 860px)").matches) closeSidebar();
    });

    elRooms.appendChild(row);
  }
}

function renderOnlineList() {
  elOnlineList.innerHTML = "";

  for (const u of onlineUsers) {
    const row = document.createElement("div");
    row.className = "userRow";

    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = initial(u);
    av.style.background = hashColor(u);

    const name = document.createElement("div");
    name.className = "userName";
    name.textContent = u === username ? `${u} (você)` : u;

    row.appendChild(av);
    row.appendChild(name);
    elOnlineList.appendChild(row);
  }

  if (onlineUsers.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "#9bb0c6";
    empty.textContent = "Ninguém online.";
    elOnlineList.appendChild(empty);
  }
}

function setTypingLine() {
  const list = typingUsers.filter((u) => u !== username);
  if (list.length === 0) elTyping.textContent = "";
  else if (list.length === 1) elTyping.textContent = `${list[0]} está digitando...`;
  else elTyping.textContent = `${list.length} pessoas digitando...`;
}

function addSystem(text) {
  const box = document.createElement("div");
  box.className = "msg system";
  box.textContent = text;
  elChat.appendChild(box);

  if (isNearBottom()) scrollToBottom();
  else setUnseen(unseenCount + 1);
}

function addMessage(msg) {
  const mine = msg.user === username;

  const box = document.createElement("div");
  box.className = "msg " + (mine ? "me" : "other");

  const meta = document.createElement("div");
  meta.className = "meta";

  const left = document.createElement("div");
  left.className = "metaLeft";

  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = initial(msg.user);
  av.style.background = hashColor(msg.user);

  const name = document.createElement("span");
  name.textContent = msg.user;

  left.appendChild(av);
  left.appendChild(name);

  const time = document.createElement("span");
  time.textContent = msg.created_at ? fmtTime(msg.created_at) : "";

  meta.appendChild(left);
  meta.appendChild(time);

  const content = document.createElement("div");
  content.className = "text";
  content.textContent = msg.text;

  box.appendChild(meta);
  box.appendChild(content);

  elChat.appendChild(box);

  if (isNearBottom()) scrollToBottom();
  else setUnseen(unseenCount + 1);
}

// unseen button
elJumpBtn.addEventListener("click", () => {
  scrollToBottom();
  setUnseen(0);
});

elChat.addEventListener("scroll", () => {
  if (isNearBottom()) setUnseen(0);
});

// join room
function joinRoom(slug) {
  currentRoom = slug;
  elRoomName.textContent = "#" + slug;

  typingUsers = [];
  setTypingLine();

  onlineUsers = [];
  renderOnlineList();

  renderRooms();
  clearChat();

  socket.emit("join_room", { roomSlug: slug, username });
}

// create room
elNewRoomBtn.addEventListener("click", () => {
  const name = prompt("Nome da sala (ex: memes, anime, geral2):");
  if (!name) return;
  socket.emit("create_room", { roomName: name });
});

// me box
elMeName.textContent = username;
elMeAvatar.textContent = initial(username);
elMeAvatar.style.background = hashColor(username);

// input behavior
function autoGrow() {
  elInput.style.height = "auto";
  elInput.style.height = Math.min(elInput.scrollHeight, 140) + "px";
}

let typingTimer = null;
function setTyping(isTyping) {
  socket.emit("typing", { isTyping });
}

elInput.addEventListener("input", () => {
  autoGrow();
  if (typingTimer) clearTimeout(typingTimer);

  const hasText = elInput.value.trim().length > 0;
  setTyping(hasText);

  typingTimer = setTimeout(() => setTyping(false), 1000);
});

elInput.addEventListener("blur", () => setTyping(false));

elInput.addEventListener("keydown", (e) => {
  const isDesktop = window.matchMedia("(pointer:fine)").matches;
  if (isDesktop && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    elForm.requestSubmit();
  }
});

elForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const text = elInput.value;
  if (!text.trim()) return;

  socket.emit("chat_message", { text });

  elInput.value = "";
  autoGrow();
  setTyping(false);
});

// socket events
socket.on("room_list", (list) => {
  rooms = list || [];
  if (!rooms.find((r) => r.slug === currentRoom)) currentRoom = rooms[0]?.slug || "geral";
  renderRooms();
});

socket.on("room_created", ({ roomSlug }) => {
  if (roomSlug) joinRoom(roomSlug);
});

socket.on("history", ({ roomSlug, messages }) => {
  if (roomSlug !== currentRoom) return;
  clearChat();
  for (const m of messages || []) addMessage(m);
  scrollToBottom();
});

socket.on("chat_message", (msg) => {
  if (!msg || msg.roomSlug !== currentRoom) return;
  addMessage(msg);
});

socket.on("system", ({ roomSlug, text }) => {
  if (roomSlug !== currentRoom) return;
  addSystem(text);
});

socket.on("presence", ({ roomSlug, users, count }) => {
  if (roomSlug !== currentRoom) return;
  onlineUsers = users || [];
  elOnlineCount.textContent = `👥 ${count ?? onlineUsers.length}`;
  if (elOnlinePanel.style.display !== "none") renderOnlineList();
});

socket.on("typing", ({ roomSlug, usersTyping }) => {
  if (roomSlug !== currentRoom) return;
  typingUsers = usersTyping || [];
  setTypingLine();
});

socket.on("admin_status", ({ ok }) => addSystem(ok ? "Admin autenticado ✅" : "Falha ao autenticar admin ❌"));
socket.on("antispam_status", ({ mode }) => console.log("Anti-spam:", mode));
socket.on("error_msg", ({ message }) => addSystem("⚠️ " + (message || "Erro")));

// start
joinRoom(currentRoom);