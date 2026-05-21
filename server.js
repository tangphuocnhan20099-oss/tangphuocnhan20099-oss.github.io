const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const rooms = new Map();
const avatarFallback = "😀";
const suits = [
  { symbol: "♠", color: "black" },
  { symbol: "♥", color: "red" },
  { symbol: "♦", color: "red" },
  { symbol: "♣", color: "black" }
];
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveIndex(res);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "Lỗi server." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bài Cào Online server: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/baicao/rooms") {
    const body = await readJson(req);
    const player = makePlayer(body);
    const room = createRoom(player);
    sendJson(res, 200, { playerId: player.id, room: serializeRoom(room, player.id) });
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "baicao" || parts[2] !== "rooms") {
    throw httpError(404, "API không tồn tại.");
  }

  const code = parts[3]?.toUpperCase();
  const room = code ? rooms.get(code) : null;
  if (!room) {
    throw httpError(404, "Không tìm thấy phòng.");
  }

  if (req.method === "GET" && parts.length === 4) {
    const playerId = url.searchParams.get("playerId");
    requirePlayer(room, playerId);
    sendJson(res, 200, { room: serializeRoom(room, playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "join") {
    const body = await readJson(req);
    if (room.phase !== "lobby") throw httpError(400, "Phòng đã bắt đầu, không thể vào thêm.");
    const player = makePlayer(body);
    if (room.players.some((current) => normalizeName(current.name) === normalizeName(player.name))) {
      throw httpError(400, "Tên này đã có trong phòng.");
    }
    if (room.players.some((current) => current.avatar === player.avatar)) {
      throw httpError(400, "Avatar này đã có trong phòng.");
    }
    room.players.push(player);
    room.message = `${player.name} vừa vào phòng.`;
    sendJson(res, 200, { playerId: player.id, room: serializeRoom(room, player.id) });
    return;
  }

  if (req.method === "POST" && parts[4] === "start") {
    const body = await readJson(req);
    requireHost(room, body.playerId);
    startRoomRound(room);
    sendJson(res, 200, { room: serializeRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "reveal") {
    const body = await readJson(req);
    requirePlayer(room, body.playerId);
    revealRoomCard(room, body.playerId, body.targetPlayerId, Number(body.cardIndex));
    sendJson(res, 200, { room: serializeRoom(room, body.playerId) });
    return;
  }

  throw httpError(404, "API không tồn tại.");
}

function createRoom(player) {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms.has(code));

  const room = {
    code,
    hostId: player.id,
    players: [player],
    phase: "lobby",
    round: null,
    message: "Phòng đã tạo. Gửi mã cho bạn bè để vào."
  };
  rooms.set(code, room);
  return room;
}

function startRoomRound(room) {
  if (room.players.length < 2) throw httpError(400, "Cần ít nhất 2 người chơi.");
  if (room.players.length * 3 > 52) throw httpError(400, "Bộ bài 52 lá chỉ đủ tối đa 17 người chơi.");

  const deck = shuffle(createDeck());
  room.phase = "playing";
  room.round = room.players.map((player, index) => ({
    ...player,
    cards: deck.slice(index * 3, index * 3 + 3),
    revealed: [false, false, false],
    currentPoints: 0,
    finalTotal: 0,
    finalPoints: 0,
    isBaCao: false,
    label: ""
  }));
  room.message = "Ván mới đã bắt đầu. Mỗi người tự lật bài của mình.";
}

function revealRoomCard(room, playerId, targetPlayerId, cardIndex) {
  if (room.phase !== "playing" || !room.round) throw httpError(400, "Ván chưa bắt đầu.");
  if (playerId !== targetPlayerId) throw httpError(403, "Bạn chỉ được lật bài của mình.");
  if (cardIndex < 0 || cardIndex > 2) throw httpError(400, "Lá bài không hợp lệ.");

  const player = room.round.find((current) => current.id === targetPlayerId);
  if (!player) throw httpError(404, "Không tìm thấy người chơi.");
  if (player.revealed[cardIndex]) return;

  player.revealed[cardIndex] = true;
  const revealedCards = player.cards.filter((_, index) => player.revealed[index]);
  player.currentPoints = pointFromCards(revealedCards);
  room.message = `${player.name} vừa lật một lá bài.`;

  if (room.round.every((current) => current.revealed.every(Boolean))) {
    settleRoom(room);
  }
}

function settleRoom(room) {
  room.round.forEach((player) => {
    player.finalTotal = rawTotal(player.cards);
    player.finalPoints = player.finalTotal % 10;
    player.currentPoints = player.finalPoints;
    player.isBaCao = isBaCao(player.cards);
  });

  const sorted = [...room.round].sort((a, b) => {
    if (a.isBaCao !== b.isBaCao) return a.isBaCao ? -1 : 1;
    return b.finalPoints - a.finalPoints;
  });
  assignRanks(sorted);
  room.message = "Ván đã xong. Chủ phòng có thể bấm Ván mới.";
}

function assignRanks(sorted) {
  let index = 0;
  while (index < sorted.length) {
    const group = sorted.filter((player) => sameScore(player, sorted[index]));
    const rank = index + 1;
    const isLastGroup = index + group.length === sorted.length;
    const label = baicaoRankLabel(rank, isLastGroup);
    group.forEach((player) => {
      player.label = label;
    });
    index += group.length;
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    message: room.message,
    players: room.players.map(({ id, name, avatar }) => ({ id, name, avatar })),
    round: room.round?.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      revealed: player.revealed,
      cards: player.cards.map((card, index) => player.revealed[index] ? publicCard(card) : null),
      currentPoints: player.currentPoints,
      label: player.label,
      statusText: player.revealed.every(Boolean)
        ? finalStatusText(player)
        : "Bấm từng lá của bạn để lật bài"
    })) || null
  };
}

function createDeck() {
  return suits.flatMap((suit) => ranks.map((rank) => ({
    rank,
    suit: suit.symbol,
    color: suit.color,
    value: cardValue(rank)
  })));
}

function publicCard(card) {
  return { rank: card.rank, suit: card.suit, color: card.color };
}

function shuffle(cards) {
  const deck = [...cards];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function cardValue(rank) {
  if (rank === "A") return 1;
  if (["J", "Q", "K"].includes(rank)) return 0;
  return Number(rank);
}

function rawTotal(cards) {
  return cards.reduce((sum, card) => sum + card.value, 0);
}

function pointFromCards(cards) {
  return rawTotal(cards) % 10;
}

function isBaCao(cards) {
  return cards.every((card) => ["J", "Q", "K"].includes(card.rank));
}

function isBuTotal(total) {
  return total === 10 || total === 20 || total === 30;
}

function sameScore(player, other) {
  return player.isBaCao === other.isBaCao && player.finalPoints === other.finalPoints;
}

function baicaoRankLabel(rank, isLastGroup) {
  if (rank === 1) return "WIN";
  if (isLastGroup) return "LOSER";
  if (rank === 2) return "2nd";
  if (rank === 3) return "3th";
  return `${rank}th`;
}

function finalStatusText(player) {
  if (player.isBaCao) return "Ba cào - lớn nhất";
  if (isBuTotal(player.finalTotal)) return "Bù - 0 nút";
  return `${player.finalPoints} nút`;
}

function makePlayer(body) {
  const name = cleanName(body.name || "");
  if (!name) throw httpError(400, "Thiếu tên người chơi.");
  return {
    id: makeId(),
    name,
    avatar: cleanName(body.avatar || avatarFallback) || avatarFallback
  };
}

function requireHost(room, playerId) {
  requirePlayer(room, playerId);
  if (room.hostId !== playerId) throw httpError(403, "Chỉ chủ phòng được bắt đầu ván.");
}

function requirePlayer(room, playerId) {
  if (!room.players.some((player) => player.id === playerId)) {
    throw httpError(403, "Bạn không thuộc phòng này.");
  }
}

function cleanName(text) {
  return String(text).trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizeName(text) {
  return cleanName(text).toLocaleLowerCase("vi");
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(httpError(413, "Dữ liệu quá lớn."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(httpError(400, "JSON không hợp lệ."));
      }
    });
    req.on("error", reject);
  });
}

function serveIndex(res) {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, "utf8", (error, html) => {
    if (error) {
      sendJson(res, 500, { error: "Không đọc được index.html." });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
