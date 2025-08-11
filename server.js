// server.js — roles + kill + sabotages + meetings + voice signaling (alive-only) + COLOR support
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomId -> room

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: new Map(), // id -> {id,name,x,y,alive,role,color,killReadyAt,ws}
      hostId: null,
      phase: 'lobby',
      votes: new Map(),
      sabotage: { type: null },
      killCooldownMs: 15000
    });
  }
  return rooms.get(roomId);
}

function roomSnapshot(room, maskRoles = true) {
  return {
    hostId: room.hostId,
    phase: room.phase,
    sabotage: room.sabotage,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      x: Math.round(p.x),
      y: Math.round(p.y),
      alive: p.alive,
      color: p.color, // include color
      role: maskRoles ? 'unknown' : p.role
    })),
  };
}

function broadcast(room, type, payload, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    try { p.ws.send(JSON.stringify({ type, payload })); } catch {}
  }
}

function assignRoles(room) {
  const ids = [...room.players.keys()];
  const sabCount = Math.max(1, Math.floor(ids.length / 5));
  const shuffled = ids.sort(() => Math.random() - 0.5);
  for (const id of ids) room.players.get(id).role = 'crew';
  for (let i = 0; i < sabCount; i++) room.players.get(shuffled[i]).role = 'sab';
}

function tallyVotes(room) {
  const counts = new Map();
  for (const [, target] of room.votes.entries()) {
    const key = target ?? 'skip';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let top = 'skip', topC = -1, tie = false;
  for (const [k, c] of counts) {
    if (c > topC) { top = k; topC = c; tie = false; }
    else if (c === topC) tie = true;
  }
  if (tie) return 'skip';
  return top;
}

function checkWin(room) {
  const alive = [...room.players.values()].filter(p => p.alive);
  const sabAlive = alive.filter(p => p.role === 'sab').length;
  const crewAlive = alive.length - sabAlive;
  if (sabAlive === 0) return 'crew';
  if (sabAlive >= crewAlive) return 'sab';
  return null;
}

function endGame(room, winner) {
  room.phase = 'ended';
  broadcast(room, 'gameEnded', { winner });
}

wss.on('connection', (ws) => {
  const playerId = uuid();
  let joinedRoomId = null;

  const send = (type, payload) => { try { ws.send(JSON.stringify({ type, payload })); } catch {} };

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const { type, payload } = msg;

    if (type === 'createRoom') {
      const rid = (Math.random().toString(36).slice(2, 7)).toUpperCase();
      ensureRoom(rid);
      send('roomCreated', { roomId: rid });
      return;
    }

    if (type === 'join') {
      const { roomId, name, color } = payload || {};
      if (!roomId) return;
      const rid = roomId.toUpperCase();
      const room = ensureRoom(rid);

      const isFirst = room.players.size === 0;
      if (isFirst) room.hostId = playerId;

      const x = 300 + Math.random()*100;
      const y = 300 + Math.random()*100;

      room.players.set(playerId, {
        id: playerId,
        name: (name || 'Player').slice(0,18),
        x, y,
        alive: true,
        role: 'crew',
        color: (typeof color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(color))
          ? (color[0] === '#' ? color : '#'+color)
          : '#7dd3fc',
        killReadyAt: Date.now(),
        ws
      });
      joinedRoomId = rid;

      send('joined', { roomId: rid, playerId, isHost: room.hostId === playerId, snapshot: roomSnapshot(room) });
      broadcast(room, 'players', roomSnapshot(room));
      return;
    }

    const room = joinedRoomId ? rooms.get(joinedRoomId) : null;
    if (!room) return;

    if (type === 'startGame') {
      if (room.hostId !== playerId) return;
      if (room.players.size < 3) return;
      assignRoles(room);
      room.phase = 'playing';
      room.votes.clear();
      room.sabotage = { type: null };
      for (const p of room.players.values()) { p.alive = true; p.killReadyAt = Date.now(); }
      for (const p of room.players.values()) {
        p.ws.send(JSON.stringify({ type: 'role', payload: { role: p.role } }));
      }
      broadcast(room, 'phase', roomSnapshot(room));
      return;
    }

    if (type === 'move' && room.phase === 'playing') {
      const p = room.players.get(playerId);
      if (!p || !p.alive) return;
      const { x, y } = payload || {};
      if (typeof x !== 'number' || typeof y !== 'number') return;
      p.x = Math.max(20, Math.min(980, x));
      p.y = Math.max(20, Math.min(580, y));
      broadcast(room, 'pos', { id: p.id, x: p.x, y: p.y }, p.id);
      return;
    }

    if (type === 'kill' && room.phase === 'playing') {
      const killer = room.players.get(playerId);
      if (!killer || !killer.alive || killer.role !== 'sab') return;
      if (Date.now() < killer.killReadyAt) return;
      const victim = room.players.get(payload?.targetId);
      if (!victim || !victim.alive) return;
      const dx = killer.x - victim.x, dy = killer.y - victim.y;
      if (dx*dx + dy*dy > 120*120) return;
      victim.alive = false;
      killer.killReadyAt = Date.now() + room.killCooldownMs;
      broadcast(room, 'killed', { targetId: victim.id });
      const win = checkWin(room); if (win) endGame(room, win);
      return;
    }

    if (type === 'sabotage' && room.phase === 'playing') {
      const s = room.players.get(playerId);
      if (!s || s.role !== 'sab' || !s.alive) return;
      if (room.sabotage.type) return;
      const kind = (payload?.kind || '').toLowerCase();
      if (kind === 'o2') room.sabotage = { type: 'o2', endsAt: Date.now()+45000, data: { left:false, right:false } };
      else if (kind === 'lights') room.sabotage = { type: 'lights', data: { fixed:false } };
      else return;
      broadcast(room, 'sabotage', room.sabotage);
      return;
    }

    if (type === 'fixSabotage' && room.phase === 'playing') {
      if (!room.sabotage.type) return;
      if (room.sabotage.type === 'lights') {
        room.sabotage = { type: null };
        broadcast(room, 'sabotage', room.sabotage);
      } else if (room.sabotage.type === 'o2') {
        const side = payload?.side === 'right' ? 'right' : 'left';
        room.sabotage.data[side] = true;
        broadcast(room, 'sabotageUpdate', room.sabotage);
        if (room.sabotage.data.left && room.sabotage.data.right) {
          room.sabotage = { type: null };
          broadcast(room, 'sabotage', room.sabotage);
        }
      }
      return;
    }

    if ((type === 'report' || type === 'callMeeting') && room.phase === 'playing') {
      room.phase = 'meeting';
      room.votes = new Map();
      broadcast(room, 'phase', roomSnapshot(room));
      return;
    }

    // Meeting chat — alive only
    if (type === 'chat' && room.phase === 'meeting') {
      const sender = room.players.get(playerId);
      if (!sender || !sender.alive) return;
      const text = (payload?.text || '').toString().slice(0, 240);
      if (text.trim()) broadcast(room, 'chat', { from: sender.name, text });
      return;
    }

    // Vote (alive only)
    if (type === 'vote' && room.phase === 'meeting') {
      const voter = room.players.get(playerId);
      if (!voter || !voter.alive) return;
      const targetId = payload?.targetId ?? null;
      if (targetId && !room.players.has(targetId)) return;
      room.votes.set(playerId, targetId);

      const aliveIds = [...room.players.values()].filter(p => p.alive).map(p => p.id);
      if (room.votes.size >= aliveIds.length) {
        const out = tallyVotes(room);
        if (out !== 'skip') {
          const expelled = room.players.get(out);
          if (expelled) expelled.alive = false;
          broadcast(room, 'expelled', { playerId: out, name: expelled?.name || 'Unknown' });
          const win = checkWin(room); if (win) { endGame(room, win); return; }
        }
        room.phase = 'playing';
        broadcast(room, 'phase', roomSnapshot(room));
      }
      return;
    }

    // WebRTC signaling (meeting only, alive-only sender & target)
    if (type === 'rtc' && room.phase === 'meeting') {
      const to = payload?.to;
      const sender = room.players.get(playerId);
      const target = to ? room.players.get(to) : null;
      if (!sender || !sender.alive) return;
      if (!target || !target.alive) return;
      const forward = { ...payload, from: playerId };
      try { target.ws.send(JSON.stringify({ type: 'rtc', payload: forward })); } catch {}
      return;
    }
  });

  ws.on('close', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    const wasHost = room.hostId === playerId;
    room.players.delete(playerId);
    if (room.players.size === 0) { rooms.delete(joinedRoomId); return; }
    if (wasHost) room.hostId = [...room.players.keys()][0];
    broadcast(room, 'players', roomSnapshot(room));
  });
});

// O₂ timeout
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'playing') continue;
    if (room.sabotage?.type === 'o2' && now > room.sabotage.endsAt) endGame(room, 'sab');
  }
}, 1000);
