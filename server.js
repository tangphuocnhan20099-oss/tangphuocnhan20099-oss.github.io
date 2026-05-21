const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const OFFLINE_AFTER_MS = 1600;
const rooms = new Map();
const xidachRooms = new Map();
const avatarFallback = "😀";
const avatarOptions = ["😀", "😎", "🤠", "🥷", "🧙", "🧛", "🦸", "👻", "🤖", "🐲", "🍀", "🔥"];
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

    if (url.pathname.startsWith("/assets/")) {
      serveAsset(res, url.pathname);
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

  if (req.method === "POST" && url.pathname === "/api/xidach/rooms") {
    const body = await readJson(req);
    const player = makePlayer(body);
    const room = createXidachRoom(player);
    sendJson(res, 200, { playerId: player.id, room: serializeXidachRoom(room, player.id) });
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[2] !== "rooms") {
    throw httpError(404, "API không tồn tại.");
  }

  if (parts[1] === "baicao") {
    await handleBaicaoApi(req, res, url, parts);
    return;
  }

  if (parts[1] === "xidach") {
    await handleXidachApi(req, res, url, parts);
    return;
  }

  throw httpError(404, "API không tồn tại.");
}

async function handleBaicaoApi(req, res, url, parts) {
  const code = parts[3]?.toUpperCase();
  const room = code ? rooms.get(code) : null;
  if (!room) {
    throw httpError(404, "Không tìm thấy phòng.");
  }

  if (req.method === "GET" && parts.length === 4) {
    const playerId = url.searchParams.get("playerId");
    touchPlayer(room, playerId);
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
    assignUniqueAvatar(player, room.players);
    room.players.push(player);
    room.message = `${player.name} vừa vào phòng.`;
    sendJson(res, 200, { playerId: player.id, room: serializeRoom(room, player.id) });
    return;
  }

  if (req.method === "POST" && parts[4] === "start") {
    const body = await readJson(req);
    requireHost(room, body.playerId);
    startRoomRound(room, Array.isArray(body.playerIds) ? body.playerIds : null);
    sendJson(res, 200, { room: serializeRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "kick") {
    const body = await readJson(req);
    requireHost(room, body.playerId);
    kickRoomPlayer(room, body.targetPlayerId);
    sendJson(res, 200, { room: serializeRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "offline") {
    const body = await readJson(req);
    markPlayerOffline(room, body.playerId);
    sendJson(res, 200, { room: serializeRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "reveal") {
    const body = await readJson(req);
    touchPlayer(room, body.playerId);
    revealRoomCard(room, body.playerId, body.targetPlayerId, Number(body.cardIndex));
    sendJson(res, 200, { room: serializeRoom(room, body.playerId) });
    return;
  }

  throw httpError(404, "API không tồn tại.");
}

async function handleXidachApi(req, res, url, parts) {
  const code = parts[3]?.toUpperCase();
  const room = code ? xidachRooms.get(code) : null;
  if (!room) {
    throw httpError(404, "Không tìm thấy phòng.");
  }

  if (req.method === "GET" && parts.length === 4) {
    const playerId = url.searchParams.get("playerId");
    touchPlayer(room, playerId);
    sendJson(res, 200, { room: serializeXidachRoom(room, playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "join") {
    const body = await readJson(req);
    if (room.phase !== "lobby") throw httpError(400, "Phòng đã bắt đầu, không thể vào thêm.");
    const player = makePlayer(body);
    if (room.players.some((current) => normalizeName(current.name) === normalizeName(player.name))) {
      throw httpError(400, "Tên này đã có trong phòng.");
    }
    assignUniqueAvatar(player, room.players);
    room.players.push(player);
    room.message = `${player.name} vừa vào phòng.`;
    sendJson(res, 200, { playerId: player.id, room: serializeXidachRoom(room, player.id) });
    return;
  }

  if (req.method === "POST" && parts[4] === "dealer") {
    const body = await readJson(req);
    requireHost(room, body.playerId);
    chooseXidachDealer(room, body.dealerId, Boolean(body.random));
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "start") {
    const body = await readJson(req);
    requireHost(room, body.playerId);
    startXidachRound(room);
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "reveal") {
    const body = await readJson(req);
    touchPlayer(room, body.playerId);
    revealXidachCard(room, body.playerId, Number(body.cardIndex));
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "hit") {
    const body = await readJson(req);
    touchPlayer(room, body.playerId);
    hitXidachCard(room, body.playerId);
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "ace") {
    const body = await readJson(req);
    touchPlayer(room, body.playerId);
    chooseXidachAceValue(room, body.playerId, Number(body.cardIndex), Number(body.value));
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "stand") {
    const body = await readJson(req);
    touchPlayer(room, body.playerId);
    standXidachHand(room, body.playerId);
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "check") {
    const body = await readJson(req);
    touchPlayer(room, body.playerId);
    checkXidachHand(room, body.playerId, body.targetPlayerId);
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "kick") {
    const body = await readJson(req);
    requireHost(room, body.playerId);
    kickXidachPlayer(room, body.targetPlayerId);
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
    return;
  }

  if (req.method === "POST" && parts[4] === "offline") {
    const body = await readJson(req);
    markPlayerOffline(room, body.playerId);
    sendJson(res, 200, { room: serializeXidachRoom(room, body.playerId) });
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
    roundNumber: 0,
    round: null,
    message: "Phòng đã tạo. Gửi mã cho bạn bè để vào."
  };
  rooms.set(code, room);
  return room;
}

function createXidachRoom(player) {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms.has(code) || xidachRooms.has(code));

  const room = {
    code,
    hostId: player.id,
    dealerId: player.id,
    players: [player],
    phase: "lobby",
    roundNumber: 0,
    deck: [],
    round: null,
    message: "Phòng Xì Dách đã tạo. Chọn ai làm cái rồi bắt đầu."
  };
  xidachRooms.set(code, room);
  return room;
}

function chooseXidachDealer(room, dealerId, randomDealer) {
  if (room.phase !== "lobby") throw httpError(400, "Chỉ được đổi cái khi còn ở phòng chờ.");
  const dealer = randomDealer
    ? room.players[Math.floor(Math.random() * room.players.length)]
    : room.players.find((player) => player.id === dealerId);
  if (!dealer) throw httpError(404, "Không tìm thấy người làm cái.");
  room.dealerId = dealer.id;
  room.message = `${dealer.name} đang làm cái.`;
}

function startXidachRound(room) {
  if (room.players.length < 2) throw httpError(400, "Cần ít nhất 2 người chơi.");
  if (room.players.length > 10) throw httpError(400, "Xì dách online hiện hỗ trợ tối đa 10 người chơi.");
  if (!room.players.some((player) => player.id === room.dealerId)) {
    room.dealerId = room.players[0].id;
  }

  const deck = shuffle(createDeck());
  const round = room.players.map((player) => ({
    ...player,
    cards: [],
    revealed: [],
    stood: false,
    checked: false,
    result: "",
    label: "",
    score: 0,
    handText: ""
  }));

  for (let dealIndex = 0; dealIndex < 2; dealIndex += 1) {
    round.forEach((player) => {
      dealXidachCard(player, deck);
    });
  }

  round.forEach(updateXidachHand);
  room.deck = deck;
  room.round = round;
  room.roundNumber += 1;
  room.phase = "playing";
  room.message = "Mỗi người lật 2 lá của mình. Bấm lá bài lớn phía trên để rút thêm.";
}

function revealXidachCard(room, playerId, cardIndex) {
  const player = requireXidachHand(room, playerId);
  if (player.checked) throw httpError(400, "Bài đã bị xét rồi.");
  if (cardIndex < 0 || cardIndex >= player.cards.length) throw httpError(400, "Lá bài không hợp lệ.");
  if (player.revealed[cardIndex]) return;

  player.revealed[cardIndex] = true;
  updateXidachHand(player);
  autoStandXidachHand(player);
  room.message = "";
}

function hitXidachCard(room, playerId) {
  const player = requireXidachHand(room, playerId);
  if (player.checked) throw httpError(400, "Bài đã bị xét rồi.");
  if (player.stood) throw httpError(400, "Bạn đã dằn bài rồi.");
  if (!player.revealed.every(Boolean)) throw httpError(400, "Lật hết bài của bạn trước khi rút.");
  if (player.cards.length >= 5) throw httpError(400, "Tối đa 5 lá.");
  if (!room.deck.length) throw httpError(400, "Bộ bài đã hết.");

  dealXidachCard(player, room.deck);
  updateXidachHand(player);
  room.message = `${player.name} vừa rút thêm một lá.`;
}

function chooseXidachAceValue(room, playerId, cardIndex, value) {
  const player = requireXidachHand(room, playerId);
  if (player.checked) throw httpError(400, "Bài đã bị xét rồi.");
  if (player.stood) throw httpError(400, "Bạn đã dằn bài rồi.");
  if (cardIndex < 0 || cardIndex >= player.cards.length) throw httpError(400, "Lá bài không hợp lệ.");
  if (!player.revealed[cardIndex]) throw httpError(400, "Lật lá Át trước khi chọn nút.");
  const card = player.cards[cardIndex];
  if (card.rank !== "A") throw httpError(400, "Chỉ lá Át mới chọn được 1 hoặc 11 nút.");
  if (value !== 1 && value !== 11) throw httpError(400, "Át chỉ được chọn 1 hoặc 11 nút.");
  card.xidachValue = value;
  updateXidachHand(player);
  autoStandXidachHand(player);
  room.message = "";
}

function standXidachHand(room, playerId) {
  const player = requireXidachHand(room, playerId);
  if (player.checked) throw httpError(400, "Bài đã bị xét rồi.");
  if (!player.revealed.every(Boolean)) throw httpError(400, "Lật hết bài của bạn trước khi dằn.");

  updateXidachHand(player);
  player.stood = true;
  room.message = `${player.name} đã dằn bài.`;
}

function checkXidachHand(room, playerId, targetPlayerId) {
  if (playerId !== room.dealerId) throw httpError(403, "Chỉ người làm cái mới được xét bài.");
  const dealer = requireXidachHand(room, room.dealerId);
  const target = requireXidachHand(room, targetPlayerId);
  if (target.id === dealer.id) throw httpError(400, "Cái không cần tự xét bài.");
  if (!dealer.revealed.every(Boolean) || !dealer.stood) {
    throw httpError(400, "Cái cần lật bài và dằn trước khi xét.");
  }
  if (!target.revealed.every(Boolean)) throw httpError(400, "Người chơi này chưa lật hết bài.");
  if (!target.stood) throw httpError(400, "Người chơi này chưa dằn bài.");
  if (target.checked) return;

  updateXidachHand(dealer);
  updateXidachHand(target);
  const targetInfo = evaluateXidachHand(target.cards);
  const dealerInfo = evaluateXidachHand(dealer.cards);
  const samePoints = targetInfo.score === dealerInfo.score;
  const bothDeadHands = isDeadXidachHand(targetInfo) && isDeadXidachHand(dealerInfo);
  const compare = bothDeadHands ? null : compareXidachHands(target.cards, dealer.cards);
  target.checked = true;
  if (samePoints) {
    target.result = "Hòa nhau";
    target.label = "HÒA";
  } else if (bothDeadHands) {
    target.result = "Cả hai thua";
    target.label = "LOSE";
  } else if (compare > 0) {
    target.result = "Thắng cái";
    target.label = "WIN";
  } else if (compare < 0) {
    target.result = "Thua cái";
    target.label = "LOSE";
  } else {
    target.result = "Hòa nhau";
    target.label = "HÒA";
  }
  room.message = `Cái vừa xét bài của ${target.name}: ${target.result}.`;

  if (room.round.filter((player) => player.id !== room.dealerId).every((player) => player.checked)) {
    room.phase = "finished";
    room.message = "";
  }
}

function kickXidachPlayer(room, targetPlayerId) {
  if (targetPlayerId === room.hostId) throw httpError(400, "Không thể kick chủ phòng.");
  const playerIndex = room.players.findIndex((player) => player.id === targetPlayerId);
  if (playerIndex === -1) throw httpError(404, "Không tìm thấy người chơi để kick.");

  const [removedPlayer] = room.players.splice(playerIndex, 1);
  if (room.round) {
    room.round = room.round.filter((player) => player.id !== targetPlayerId);
  }
  if (room.dealerId === targetPlayerId) {
    room.dealerId = room.players[0]?.id || "";
  }
  room.message = `${removedPlayer.name} đã bị kick khỏi phòng.`;

  if (room.players.length < 2 || room.dealerId === "") {
    room.phase = "lobby";
    room.round = null;
    room.deck = [];
    room.message += " Ván đã dừng vì không đủ người chơi.";
  }
}

function dealXidachCard(player, deck) {
  player.cards.push(deck.pop());
  player.revealed.push(false);
}

function requireXidachHand(room, playerId) {
  if ((room.phase !== "playing" && room.phase !== "finished") || !room.round) {
    throw httpError(400, "Ván Xì Dách chưa bắt đầu.");
  }
  const player = room.round.find((current) => current.id === playerId);
  if (!player) throw httpError(404, "Không tìm thấy người chơi.");
  return player;
}

function updateXidachHand(player) {
  const info = evaluateXidachHand(player.cards);
  player.score = info.score;
  player.handText = info.text;
}

function autoStandXidachHand(player) {
  if (!player.revealed.every(Boolean)) return;
  const info = evaluateXidachHand(player.cards);
  if (info.autoStand) {
    player.stood = true;
  }
}

function evaluateXidachHand(cards) {
  const score = xidachBestScore(cards);
  const hasAce = cards.some((card) => card.rank === "A");
  const tenLike = cards.some((card) => ["10", "J", "Q", "K"].includes(card.rank));
  const twoAces = cards.length === 2 && cards.every((card) => card.rank === "A");
  if (twoAces) return { rank: 5, score: 22, text: "Xì bàn", autoStand: true };
  if (cards.length === 2 && hasAce && tenLike) return { rank: 4, score: 21, text: "Xì dách", autoStand: true };
  if (cards.length === 5 && score === 21) return { rank: 3, score, text: `Ngũ linh - ${score} điểm`, autoStand: true };
  if (score > 21) return { rank: 0, score, text: `Quắc - ${score} điểm`, autoStand: true };
  if (score < 12) return { rank: 1, score, text: `Dằn dơ - ${score} điểm`, autoStand: false };
  if (score < 16) return { rank: 1, score, text: `Non - ${score} điểm`, autoStand: false };
  return { rank: 2, score, text: `${score} điểm`, autoStand: false };
}

function compareXidachHands(playerCards, dealerCards) {
  const player = evaluateXidachHand(playerCards);
  const dealer = evaluateXidachHand(dealerCards);
  if (player.score === dealer.score && player.rank !== 0 && dealer.rank !== 0) return 0;
  if (player.rank !== dealer.rank) return player.rank > dealer.rank ? 1 : -1;
  if (player.score !== dealer.score) return player.score > dealer.score ? 1 : -1;
  return 0;
}

function isDeadXidachHand(info) {
  return info.rank === 0 || info.rank === 1;
}

function xidachBestScore(cards) {
  let totals = [0];
  cards.forEach((card) => {
    const values = card.rank === "A"
      ? [card.xidachValue].filter((value) => value === 1 || value === 11)
      : [xidachCardValue(card.rank)];
    const cardValues = values.length ? values : [1, 11];
    totals = totals.flatMap((total) => cardValues.map((value) => total + value));
  });
  const valid = totals.filter((total) => total <= 21);
  return valid.length ? Math.max(...valid) : Math.min(...totals);
}

function xidachCardValue(rank) {
  if (["J", "Q", "K"].includes(rank)) return 10;
  return Number(rank);
}

function serializeXidachRoom(room, viewerId) {
  const now = Date.now();
  const livePlayers = new Map(room.players.map((player) => [player.id, player]));
  const roundComplete = Boolean(room.round?.length)
    && room.round.filter((player) => player.id !== room.dealerId).every((player) => player.checked);

  return {
    code: room.code,
    hostId: room.hostId,
    dealerId: room.dealerId,
    phase: room.phase,
    roundNumber: room.roundNumber,
    message: room.message,
    deckCount: room.deck?.length || 0,
    roundComplete,
    players: room.players.map(({ id, name, avatar, lastSeen }) => ({
      id,
      name,
      avatar,
      online: isPlayerOnline({ lastSeen }, now)
    })),
    round: room.round?.map((player) => serializeXidachHand(player, viewerId, room.dealerId, livePlayers, now, room.round)) || null
  };
}

function serializeXidachHand(player, viewerId, dealerId, livePlayers, now, round) {
  const isSelf = player.id === viewerId;
  const isDealer = player.id === dealerId;
  const viewerIsDealer = viewerId === dealerId;
  const allRevealed = player.revealed.every(Boolean);
  const dealerCanViewCheckedHand = viewerIsDealer && !isDealer && player.checked;
  const visibleInfo = visibleXidachInfo(player);
  let statusText = isSelf ? visibleInfo.text : "";
  if (!isSelf && player.stood) statusText = "Đã dằn";
  if (!isSelf && player.checked) statusText = player.result || "Đã xét bài";
  if (dealerCanViewCheckedHand) statusText = `${player.result} - ${player.handText}`;
  if (isSelf && player.checked) statusText = player.result || statusText;

  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    online: isPlayerOnline(livePlayers.get(player.id), now),
    isDealer,
    stood: player.stood,
    checked: player.checked,
    result: player.result,
    label: isDealer ? "" : player.label,
    cardCount: player.cards.length,
    scoreboard: isSelf && player.checked ? xidachScoreboard(round, dealerId) : null,
    cards: isSelf
      ? player.cards.map((card, index) => player.revealed[index] ? publicCard(card) : null)
      : dealerCanViewCheckedHand
        ? player.cards.map(publicCard)
      : [],
    score: isSelf ? visibleInfo.score : dealerCanViewCheckedHand ? player.score : null,
    statusText
  };
}

function xidachScoreboard(round, dealerId) {
  return round.map((player) => ({
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    isDealer: player.id === dealerId,
    score: player.score,
    result: player.result
  }));
}

function visibleXidachInfo(player) {
  const visibleCards = player.cards.filter((_, index) => player.revealed[index]);
  if (!visibleCards.length) return { score: null, text: "" };
  const info = evaluateXidachHand(visibleCards);
  return { score: info.score, text: info.text };
}

function startRoomRound(room, playerIds = null) {
  const idSet = Array.isArray(playerIds) && playerIds.length ? new Set(playerIds) : null;
  const roundPlayers = idSet ? room.players.filter((player) => idSet.has(player.id)) : room.players;
  if (roundPlayers.length < 2) throw httpError(400, "Cần ít nhất 2 người chơi.");
  if (roundPlayers.length * 3 > 52) throw httpError(400, "Bộ bài 52 lá chỉ đủ tối đa 17 người chơi.");

  const deck = shuffle(createDeck());
  room.phase = "playing";
  room.roundNumber += 1;
  room.round = roundPlayers.map((player, index) => ({
    ...player,
    cards: deck.slice(index * 3, index * 3 + 3),
    revealed: [false, false, false],
    currentPoints: 0,
    finalTotal: 0,
    finalPoints: 0,
    isBaCao: false,
    label: ""
  }));
  room.message = "";
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
  room.message = "";

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
  room.message = "";
}

function kickRoomPlayer(room, targetPlayerId) {
  if (targetPlayerId === room.hostId) throw httpError(400, "Không thể kick chủ phòng.");
  const playerIndex = room.players.findIndex((player) => player.id === targetPlayerId);
  if (playerIndex === -1) throw httpError(404, "Không tìm thấy người chơi để kick.");

  const [removedPlayer] = room.players.splice(playerIndex, 1);
  if (room.round) {
    room.round = room.round.filter((player) => player.id !== targetPlayerId);
  }

  room.message = `${removedPlayer.name} đã bị kick khỏi phòng.`;

  if (room.phase === "playing" && (!room.round || room.round.length < 2)) {
    room.phase = "lobby";
    room.round = null;
    room.message += " Ván đã dừng vì không đủ người chơi.";
    return;
  }

  if (room.phase === "playing" && room.round.every((player) => player.revealed.every(Boolean))) {
    settleRoom(room);
  }
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

function serializeRoom(room, viewerId) {
  const now = Date.now();
  const livePlayers = new Map(room.players.map((player) => [player.id, player]));
  const allRevealed = Boolean(room.round?.length)
    && room.round.every((player) => player.revealed.every(Boolean));
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    roundNumber: room.roundNumber,
    message: room.message,
    players: room.players.map(({ id, name, avatar, lastSeen }) => ({
      id,
      name,
      avatar,
      online: isPlayerOnline({ lastSeen }, now)
    })),
    round: room.round?.map((player) => serializeBaicaoHand(player, viewerId, livePlayers, now, allRevealed)) || null
  };
}

function serializeBaicaoHand(player, viewerId, livePlayers, now, allRevealed) {
  const isSelf = player.id === viewerId;
  const canViewHand = isSelf || allRevealed;
  const visibleRevealed = canViewHand ? player.revealed : player.revealed.map(() => false);
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    online: isPlayerOnline(livePlayers.get(player.id), now),
    revealed: visibleRevealed,
    cards: player.cards.map((card, index) => canViewHand && player.revealed[index] ? publicCard(card) : null),
    currentPoints: canViewHand ? player.currentPoints : null,
    label: allRevealed ? player.label : "",
    statusText: ""
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
  return {
    rank: card.rank,
    suit: card.suit,
    color: card.color,
    xidachValue: card.xidachValue || null
  };
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
    avatar: cleanName(body.avatar || avatarFallback) || avatarFallback,
    lastSeen: Date.now()
  };
}

function assignUniqueAvatar(player, players) {
  const usedAvatars = new Set(players.map((current) => current.avatar));
  if (!usedAvatars.has(player.avatar)) return;
  const freeAvatar = avatarOptions.find((avatar) => !usedAvatars.has(avatar));
  if (!freeAvatar) throw httpError(400, "Phòng đã hết avatar trống.");
  player.avatar = freeAvatar;
}

function requireHost(room, playerId) {
  touchPlayer(room, playerId);
  if (room.hostId !== playerId) throw httpError(403, "Chỉ chủ phòng được thao tác.");
}

function requirePlayer(room, playerId) {
  const player = room.players.find((current) => current.id === playerId);
  if (!player) {
    throw httpError(403, "Bạn không thuộc phòng này.");
  }
  return player;
}

function touchPlayer(room, playerId) {
  const player = requirePlayer(room, playerId);
  player.lastSeen = Date.now();
  return player;
}

function markPlayerOffline(room, playerId) {
  const player = requirePlayer(room, playerId);
  player.lastSeen = 0;
  return player;
}

function isPlayerOnline(player, now = Date.now()) {
  return Boolean(player?.lastSeen && now - player.lastSeen <= OFFLINE_AFTER_MS);
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

function serveAsset(res, pathname) {
  const assetsRoot = path.join(__dirname, "assets");
  const assetPath = path.join(__dirname, decodeURIComponent(pathname));
  const relativePath = path.relative(assetsRoot, assetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendJson(res, 403, { error: "Không được phép đọc file này." });
    return;
  }

  fs.readFile(assetPath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "Không tìm thấy asset." });
      return;
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(assetPath), "Cache-Control": "public, max-age=3600" });
    res.end(data);
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
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
