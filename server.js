const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ===== CORS & HEADERS =====
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});

// Serve static files (for local dev)
app.use(express.static(path.join(__dirname)));

// Health check endpoint (Render uses this)
app.get('/health', function (req, res) {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

// ===== WEBSOCKET SERVER =====
const wss = new WebSocketServer({
  server: server,
  // Allow connections from any origin (Netlify, localhost, etc.)
  verifyClient: function () { return true; }
});

// ===== ROOM MANAGEMENT =====
const rooms = new Map();
let nextPlayerId = 1;

const PLAYER_COLORS = [
  { body: '#fde047', stroke: '#ca8a04', name: 'Yellow',  wing: '#fff8dc' },
  { body: '#f472b6', stroke: '#be185d', name: 'Pink',  wing: '#fce7f3' },
  { body: '#60a5fa', stroke: '#1d4ed8', name: 'Blue',  wing: '#dbeafe' },
  { body: '#a78bfa', stroke: '#6d28d9', name: 'Purple',   wing: '#ede9fe' },
];

function generateCode() {
  const chars = '0123456789';
  let code;
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 3; i++) code += chars[Math.floor(Math.random() * chars.length)];
    attempts++;
    if (attempts > 5000) {
      code = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      break;
    }
  } while (rooms.has(code));
  return code;
}

function generateSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function getPlayerList(room) {
  return room.players.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      colorIndex: p.colorIndex,
      color: PLAYER_COLORS[p.colorIndex],
      isHost: p.id === room.hostId,
    };
  });
}

function broadcastToRoom(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  room.players.forEach(function (p) {
    if (p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  });
}

function sendToAll(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(function (p) {
    if (p.ws.readyState === 1) p.ws.send(data);
  });
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function removePlayerFromRoom(ws) {
  const roomCode = ws._roomCode;
  const playerId = ws._playerId;
  if (!roomCode || !rooms.has(roomCode)) return;

  const room = rooms.get(roomCode);
  room.players = room.players.filter(function (p) { return p.id !== playerId; });

  if (room.players.length === 0) {
    rooms.delete(roomCode);
    console.log('[Room ' + roomCode + '] Deleted (empty)');
    return;
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
    console.log('[Room ' + roomCode + '] New host: ' + room.players[0].name);
  }

  sendToAll(room, {
    type: 'room',
    code: roomCode,
    players: getPlayerList(room),
    hostId: room.hostId,
  });

  if (room.state === 'playing') {
    const alive = room.players.filter(function (p) { return p.alive !== false; });
    if (alive.length <= 1) {
      room.state = 'ended';
      sendToAll(room, { type: 'gameover' });
    }
  }

  console.log('[Room ' + roomCode + '] Player left. ' + room.players.length + ' remaining');
}

// ===== WEBSOCKET HANDLING =====
wss.on('connection', function (ws, req) {
  ws._playerId = nextPlayerId++;
  console.log('[WS] New connection #' + ws._playerId + ' from ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));

  // Ping/pong to keep connection alive on Render
  ws._pingInterval = setInterval(function () {
    if (ws.readyState === 1) {
      ws.ping();
    } else {
      clearInterval(ws._pingInterval);
    }
  }, 30000);

  ws.on('pong', function () {
    ws._isAlive = true;
  });

  ws.on('message', function (raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {

      case 'create': {
        const code = generateCode();
        const preferredColor = (typeof msg.colorIndex === 'number' && msg.colorIndex >= 0 && msg.colorIndex < 4) ? msg.colorIndex : 0;
        const player = {
          id: ws._playerId,
          ws: ws,
          name: (msg.name || 'Player').substring(0, 12),
          colorIndex: preferredColor,
          alive: true,
        };
        const room = {
          code: code,
          hostId: ws._playerId,
          players: [player],
          state: 'lobby',
          seed: 0,
        };
        rooms.set(code, room);
        ws._roomCode = code;

        send(ws, {
          type: 'room',
          code: code,
          players: getPlayerList(room),
          hostId: room.hostId,
          yourId: ws._playerId,
        });
        console.log('[Room ' + code + '] Created by ' + player.name);
        break;
      }

      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        if (!rooms.has(code)) {
          send(ws, { type: 'error', msg: 'Room does not exist!' });
          return;
        }
        const room = rooms.get(code);
        if (room.players.length >= 4) {
          send(ws, { type: 'error', msg: 'Room is full (max 4 players)!' });
          return;
        }
        if (room.state !== 'lobby') {
          send(ws, { type: 'error', msg: 'Game is running, cannot join!' });
          return;
        }

        const usedColors = new Set(room.players.map(function (p) { return p.colorIndex; }));
        let colorIdx = (typeof msg.colorIndex === 'number' && msg.colorIndex >= 0 && msg.colorIndex < 4) ? msg.colorIndex : 0;
        if (usedColors.has(colorIdx)) {
          for (let i = 0; i < 4; i++) {
            if (!usedColors.has(i)) { colorIdx = i; break; }
          }
        }

        const player = {
          id: ws._playerId,
          ws: ws,
          name: (msg.name || 'Player').substring(0, 12),
          colorIndex: colorIdx,
          alive: true,
        };
        room.players.push(player);
        ws._roomCode = code;

        send(ws, {
          type: 'room',
          code: code,
          players: getPlayerList(room),
          hostId: room.hostId,
          yourId: ws._playerId,
        });

        broadcastToRoom(room, {
          type: 'room',
          code: code,
          players: getPlayerList(room),
          hostId: room.hostId,
        }, ws);

        console.log('[Room ' + code + '] ' + player.name + ' joined (' + room.players.length + '/4)');
        break;
      }

      case 'start': {
        const room = rooms.get(ws._roomCode);
        if (!room) return;
        if (room.hostId !== ws._playerId) {
          send(ws, { type: 'error', msg: 'Only host can start the game!' });
          return;
        }
        if (room.players.length < 2) {
          send(ws, { type: 'error', msg: 'Need at least 2 players!' });
          return;
        }

        room.state = 'playing';
        room.seed = generateSeed();
        room.players.forEach(function (p) { p.alive = true; });

        sendToAll(room, {
          type: 'go',
          seed: room.seed,
          players: getPlayerList(room),
        });
        console.log('[Room ' + room.code + '] Game started! Seed: ' + room.seed);
        break;
      }

      case 'state': {
        const room = rooms.get(ws._roomCode);
        if (!room || room.state !== 'playing') return;

        const player = room.players.find(function (p) { return p.id === ws._playerId; });
        if (!player) return;

        player.lastState = {
          y: msg.y,
          vy: msg.vy,
          rot: msg.rot,
          score: msg.score || 0,
          alive: msg.alive,
          wingPhase: msg.wingPhase || 0,
          flapTimer: msg.flapTimer || 0,
        };

        if (msg.alive === false) player.alive = false;

        const states = {};
        room.players.forEach(function (p) {
          if (p.lastState) states[p.id] = p.lastState;
        });

        broadcastToRoom(room, { type: 'sync', states: states }, ws);

        const allDead = room.players.every(function (p) { return !p.alive; });
        if (allDead && room.state === 'playing') {
          room.state = 'ended';
          const rankings = room.players.map(function (p) {
            return {
              id: p.id,
              name: p.name,
              colorIndex: p.colorIndex,
              color: PLAYER_COLORS[p.colorIndex],
              score: p.lastState ? p.lastState.score : 0,
            };
          }).sort(function (a, b) { return b.score - a.score; });

          sendToAll(room, { type: 'gameover', rankings: rankings });
          console.log('[Room ' + room.code + '] Game over! Winner: ' + rankings[0].name + ' (' + rankings[0].score + ')');
        }
        break;
      }

      case 'restart': {
        const room = rooms.get(ws._roomCode);
        if (!room) return;
        if (room.hostId !== ws._playerId) return;

        room.state = 'lobby';
        room.players.forEach(function (p) { p.alive = true; p.lastState = null; });

        sendToAll(room, {
          type: 'room',
          code: room.code,
          players: getPlayerList(room),
          hostId: room.hostId,
        });
        console.log('[Room ' + room.code + '] Back to lobby');
        break;
      }
    }
  });

  ws.on('close', function () {
    clearInterval(ws._pingInterval);
    removePlayerFromRoom(ws);
    console.log('[WS] Connection #' + ws._playerId + ' closed');
  });

  ws.on('error', function (err) {
    console.error('[WS] Error on #' + ws._playerId + ':', err.message);
    clearInterval(ws._pingInterval);
    removePlayerFromRoom(ws);
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', function () {
  const nets = require('os').networkInterfaces();
  let lanIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { lanIP = net.address; break; }
    }
  }
  console.log('');
  console.log('🐤 ══════════════════════════════════════════');
  console.log('   FLAPPY BIRD MULTIPLAYER SERVER');
  console.log('══════════════════════════════════════════════');
  console.log('   Local:   http://localhost:' + PORT);
  console.log('   LAN:     http://' + lanIP + ':' + PORT);
  console.log('   Health:  http://localhost:' + PORT + '/health');
  console.log('══════════════════════════════════════════════');
  console.log('   NODE_ENV: ' + (process.env.NODE_ENV || 'development'));
  console.log('══════════════════════════════════════════════');
  console.log('');
});
