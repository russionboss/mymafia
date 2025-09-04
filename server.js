// server.js — полный сервер для Мафии с поддержкой смены ника и сигналингом WebRTC
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { nanoid } = require('nanoid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// helper send
function send(ws, type, payload = {}) {
  try {
    ws.send(JSON.stringify({ type, payload }));
  } catch (e) { /* ignore */ }
}

const PORT = process.env.PORT || 3000;

// In-memory rooms
const rooms = {}; // roomId -> room object

function broadcastToRoom(room, type, payload) {
  if (!room) return;
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      send(p.ws, type, payload);
    }
  });
}

function broadcastRoomsList() {
  const list = Object.values(rooms).map(r => ({
    id: r.id, name: r.name, players: r.players.length, state: r.state
  }));
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      send(client, 'roomsList', { rooms: list });
    }
  });
}

function createRoom(name) {
  const id = nanoid(6);
  const room = {
    id,
    name: name || `Комната ${id}`,
    players: [], // { id, name, avatar, ws, role, alive }
    hostWsId: null,
    state: 'waiting',
    phaseTimer: null,
    phaseEnd: null,
    dayCount: 0,
    votes: {},
    nightActions: { mafiaVotes: {}, commissarChecks: {} },
    log: []
  };
  rooms[id] = room;
  return room;
}

function getPlayersPublic(room, forPlayerId = null) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    alive: p.alive,
    role: p.id === forPlayerId ? p.role : null
  }));
}

function assignRoles(room) {
  const count = room.players.length;
  let mafiaCount = Math.max(1, Math.floor(count / 4));
  if (count <= 5) mafiaCount = 1;
  const rolePool = [];
  for (let i = 0; i < mafiaCount; i++) rolePool.push('mafia');
  rolePool.push('commissar');
  while (rolePool.length < count) rolePool.push('villager');
  // shuffle
  for (let i = rolePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
  }
  room.players.forEach((p, idx) => {
    p.role = rolePool[idx];
    p.alive = true;
  });
}

function getAlivePlayers(room) {
  return room.players.filter(p => p.alive);
}

function checkEndConditions(room) {
  const alive = getAlivePlayers(room);
  const mafia = alive.filter(p => p.role === 'mafia').length;
  const villagers = alive.filter(p => p.role !== 'mafia').length;
  if (mafia === 0) return { ended: true, winner: 'villagers' };
  if (mafia >= villagers) return { ended: true, winner: 'mafia' };
  return { ended: false };
}

function startPhase(room, phase, durationSec = 60) {
  room.state = phase;
  room.phaseEnd = Date.now() + durationSec * 1000;
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  broadcastToRoom(room, 'phaseStarted', { phase, endsAt: room.phaseEnd });

  room.phaseTimer = setTimeout(() => {
    if (phase === 'night') resolveNight(room);
    else if (phase === 'day') resolveDay(room);
  }, durationSec * 1000);
}

function resolveNight(room) {
  const mafiaVotes = room.nightActions.mafiaVotes || {};
  const tally = {};
  Object.values(mafiaVotes).forEach(tid => {
    if (!tid) return;
    tally[tid] = (tally[tid] || 0) + 1;
  });
  let victimId = null;
  let max = 0;
  Object.entries(tally).forEach(([tid, cnt]) => {
    if (cnt > max) { max = cnt; victimId = tid; }
  });

  // Commissar checks
  const checks = room.nightActions.commissarChecks || {};
  Object.entries(checks).forEach(([commId, checkedId]) => {
    const target = room.players.find(p => p.id === checkedId);
    if (target) {
      const comm = room.players.find(p => p.id === commId);
      if (comm && comm.ws && comm.ws.readyState === WebSocket.OPEN) {
        send(comm.ws, 'commCheckResult', { checkedId, role: target.role });
      }
    }
  });

  if (victimId) {
    const victim = room.players.find(p => p.id === victimId);
    if (victim) {
      victim.alive = false;
      room.log.push({ type: 'nightKill', victimId, day: room.dayCount + 1 });
    }
  }

  room.nightActions = { mafiaVotes: {}, commissarChecks: {} };

  const end = checkEndConditions(room);
  if (end.ended) {
    room.state = 'finished';
    broadcastToRoom(room, 'gameEnded', { winner: end.winner });
    return;
  }

  room.dayCount++;
  startPhase(room, 'day', 90);
  broadcastToRoom(room, 'nightResult', { victimId });
}

function resolveDay(room) {
  const votes = room.votes || {};
  const tally = {};
  Object.values(votes).forEach(tid => {
    if (!tid) return;
    tally[tid] = (tally[tid] || 0) + 1;
  });
  let executedId = null;
  let max = 0;
  Object.entries(tally).forEach(([tid, cnt]) => {
    if (cnt > max) { max = cnt; executedId = tid; }
    else if (cnt === max) executedId = null;
  });
  if (executedId) {
    const target = room.players.find(p => p.id === executedId);
    if (target) {
      target.alive = false;
      room.log.push({ type: 'executed', victimId: executedId, day: room.dayCount });
    }
  }

  broadcastToRoom(room, 'dayResult', { executedId, tally });
  room.votes = {};

  const end = checkEndConditions(room);
  if (end.ended) {
    room.state = 'finished';
    broadcastToRoom(room, 'gameEnded', { winner: end.winner });
    return;
  }

  startPhase(room, 'night', 60);
}

// WebSocket handling
wss.on('connection', (ws) => {
  ws._internalId = nanoid(8);
  ws.roomId = null;
  ws.playerId = null;

  send(ws, 'connected', { wsId: ws._internalId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const { type, payload } = msg;

    // createRoom
    if (type === 'createRoom') {
      const room = createRoom(payload && payload.name);
      room.hostWsId = ws._internalId;
      send(ws, 'roomCreated', { roomId: room.id, roomName: room.name });
      broadcastRoomsList();
      return;
    }

    // listRooms
    if (type === 'listRooms') {
      send(ws, 'roomsList', { rooms: Object.values(rooms).map(r => ({ id: r.id, name: r.name, players: r.players.length, state: r.state }))});
      return;
    }

    // joinRoom
    if (type === 'joinRoom') {
      const { roomId, name, avatar } = payload || {};
      const room = rooms[roomId];
      if (!room) { send(ws, 'error', { message: 'Комната не найдена' }); return; }
      const playerId = nanoid(8);
      const player = { id: playerId, ws, name: name || 'Игрок', avatar: avatar || '', role: null, alive: true };
      room.players.push(player);
      ws.roomId = roomId;
      ws.playerId = playerId;
      send(ws, 'joined', { playerId, roomId, roomName: room.name });
      broadcastToRoom(room, 'playerList', { players: getPlayersPublic(room) });
      broadcastRoomsList();
      return;
    }

    // leaveRoom
    if (type === 'leaveRoom') {
      const room = rooms[ws.roomId];
      if (room) {
        room.players = room.players.filter(p => p.id !== ws.playerId);
        broadcastToRoom(room, 'playerList', { players: getPlayersPublic(room) });
        if (room.players.length === 0) {
          if (room.phaseTimer) clearTimeout(room.phaseTimer);
          delete rooms[room.id];
          broadcastRoomsList();
        }
      }
      ws.roomId = null; ws.playerId = null;
      return;
    }

    // changeName (новая функция)
    if (type === 'changeName') {
      const newName = payload && payload.name && String(payload.name).trim();
      if (!newName) { send(ws, 'error', { message: 'Пустое имя' }); return; }
      const room = rooms[ws.roomId];
      let oldName = null;
      if (room) {
        const pl = room.players.find(p => p.id === ws.playerId);
        if (pl) {
          oldName = pl.name;
          pl.name = newName;
          // оповестить комнату о новом списке игроков
          broadcastToRoom(room, 'playerList', { players: getPlayersPublic(room) });
          // системное сообщение в чат
          const sys = { from: null, name: 'Система', text: `${oldName} сменил ник на ${newName}`, ts: Date.now() };
          room.log.push({ type: 'chat', ...sys });
          broadcastToRoom(room, 'chatMessage', sys);
        }
      }
      send(ws, 'nameChanged', { name: newName });
      return;
    }

    // startGame
    if (type === 'startGame') {
      const room = rooms[ws.roomId];
      if (!room) return;
      if (room.players.length < 3) {
        send(ws, 'error', { message: 'Минимум 3 игрока требуется' });
        return;
      }
      assignRoles(room);
      room.players.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
          send(p.ws, 'roleAssigned', { role: p.role, players: getPlayersPublic(room, p.id) });
        }
      });
      room.dayCount = 0;
      room.votes = {};
      room.nightActions = { mafiaVotes: {}, commissarChecks: {} };
      startPhase(room, 'night', 60);
      return;
    }

    // sendChat
    if (type === 'sendChat') {
      const room = rooms[ws.roomId];
      if (!room) return;
      const player = room.players.find(p => p.id === ws.playerId);
      const text = payload && payload.text;
      const entry = { from: player ? player.id : null, name: player ? player.name : '??', text, ts: Date.now() };
      room.log.push({ type: 'chat', ...entry });
      broadcastToRoom(room, 'chatMessage', entry);
      return;
    }

    // mafiaVote
    if (type === 'mafiaVote') {
      const room = rooms[ws.roomId]; if (!room) return;
      const player = room.players.find(p => p.id === ws.playerId);
      if (!player || player.role !== 'mafia' || !player.alive) return;
      const targetId = payload && payload.targetId;
      room.nightActions.mafiaVotes[player.id] = targetId;
      broadcastToRoom(room, 'nightActionUpdate', { actor: player.id });
      return;
    }

    // commissarCheck
    if (type === 'commissarCheck') {
      const room = rooms[ws.roomId]; if (!room) return;
      const player = room.players.find(p => p.id === ws.playerId);
      if (!player || player.role !== 'commissar' || !player.alive) return;
      const targetId = payload && payload.targetId;
      room.nightActions.commissarChecks[player.id] = targetId;
      send(ws, 'commCheckQueued', { targetId });
      return;
    }

    // vote (day)
    if (type === 'vote') {
      const room = rooms[ws.roomId]; if (!room) return;
      const player = room.players.find(p => p.id === ws.playerId);
      if (!player || !player.alive) return;
      const targetId = (payload && payload.targetId) || null;
      room.votes[player.id] = targetId;
      broadcastToRoom(room, 'voteUpdate', { votesCount: Object.keys(room.votes).length, totalAlive: getAlivePlayersCount(room) });
      return;
    }

    // requestRoomState
    if (type === 'requestRoomState') {
      const room = rooms[ws.roomId]; if (!room) return;
      send(ws, 'roomState', {
        room: { id: room.id, name: room.name, state: room.state, dayCount: room.dayCount },
        players: getPlayersPublic(room, ws.playerId),
        phaseEnd: room.phaseEnd
      });
      return;
    }

    // kick
    if (type === 'kick') {
      const room = rooms[ws.roomId]; if (!room) return;
      if (ws._internalId !== (room.hostWsId || '')) return;
      const targetPlayerId = payload && payload.playerId;
      const idx = room.players.findIndex(p => p.id === targetPlayerId);
      if (idx !== -1) {
        const p = room.players[idx];
        if (p.ws) {
          send(p.ws, 'kicked', {});
          p.ws.roomId = null; p.ws.playerId = null;
        }
        room.players.splice(idx, 1);
        broadcastToRoom(room, 'playerList', { players: getPlayersPublic(room) });
      }
      return;
    }

    // signaling - forward offer/answer/candidate
    if (type === 'signal') {
      const room = rooms[ws.roomId]; if (!room) return;
      const toId = payload && payload.to;
      if (!toId) return;
      const target = room.players.find(p => p.id === toId);
      if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({
          type: 'signal',
          payload: {
            from: ws.playerId,
            offer: payload.offer,
            answer: payload.answer,
            candidate: payload.candidate
          }
        }));
      }
      return;
    }

    // unknown type -> ignore
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (room) {
      room.players = room.players.filter(p => p.id !== ws.playerId);
      broadcastToRoom(room, 'playerList', { players: getPlayersPublic(room) });
      if (room.players.length === 0) {
        if (room.phaseTimer) clearTimeout(room.phaseTimer);
        delete rooms[room.id];
        broadcastRoomsList();
      }
    }
  });
});

function getAlivePlayersCount(room) {
  return room.players.filter(p => p.alive).length;
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

