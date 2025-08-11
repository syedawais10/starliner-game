// client.js — colors + hats/skins + idle/walk anim + map collision + simple tasks
const $ = sel => document.querySelector(sel);

// Lobby inputs
const nameInput = $('#name');
const roomInput = $('#room');
const colorInput = $('#color');
const hatInput   = $('#hat');
const skinInput  = $('#skin');

// Buttons
const btnCreate = $('#create');
const btnJoin   = $('#join');
const btnStart  = $('#start');

const roomIdEl  = $('#roomId');
const meEl      = $('#me');
const hostEl    = $('#host');
const playersEl = $('#players');
const phaseEl   = $('#phase');
const roleEl    = $('#role');

const tasksDoneEl = $('#tasksDone');
const tasksTotalEl= $('#tasksTotal');
const taskHintEl  = $('#taskHint');

// Actions
const btnReport   = $('#btnReport');
const btnEmergency= $('#btnEmergency');
const btnKill     = $('#btnKill');
const btnSabotage = $('#btnSabotage');
const btnFix      = $('#btnFix');

// Canvas
const gameWrap = document.getElementById('gameWrap');
const canvas   = document.getElementById('game');
const ctx      = canvas.getContext('2d');

// Meeting UI
const meeting   = $('#meeting');
const voteList  = $('#voteList');
const chatBox   = $('#chat');
const chatInput = $('#chatInput');
const voteSkip  = $('#voteSkip');

// Voice UI
const vcJoin = $('#vcJoin');
const vcMute = $('#vcMute');
const vcLeave= $('#vcLeave');
const voicePeers = $('#voicePeers');

// WebSocket + status badge
const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host);
const statusBadge = document.createElement('span');
statusBadge.className = 'pill';
statusBadge.style.marginLeft = '8px';
statusBadge.textContent = 'WS: connecting…';
document.querySelector('h1')?.appendChild(statusBadge);
function updateWsBadge() {
  const s = ws.readyState;
  statusBadge.textContent = s===0 ? 'WS: connecting…' : s===1 ? 'WS: connected' : s===2 ? 'WS: closing…' : 'WS: closed';
  statusBadge.style.background = s===1 ? '#0f3a1f' : '#3a1f1f';
}
ws.addEventListener('open',  updateWsBadge);
ws.addEventListener('close', updateWsBadge);
ws.addEventListener('error', updateWsBadge);
updateWsBadge();

// State
let myId = null, currentRoomId = null, isHost = false;
let phase = 'lobby';
let myRole = 'unknown';
let sabotage = { type: null };
let players = new Map(); // id -> {id,name,x,y,alive,color,hat,skin,role}
let tasksDone = 0, tasksTotal = 0;
const myCompletedTasks = new Set(); // local help for hints

// Input + anim state
const keys = new Set();
let lastSent = 0;
let timeSec = 0; // animation time

// Voice
const peers = new Map();
let mediaStream = null;
let micEnabled = true;

/* ====== MAP (very simple) ====== */
// Walls: array of rectangles {x,y,w,h}
const walls = [
  {x:40,y:40,w:880,h:20},   // top
  {x:40,y:480,w:880,h:20},  // bottom
  {x:40,y:60,w:20,h:420},   // left
  {x:900,y:60,w:20,h:420},  // right

  // rooms inside
  {x:160,y:120,w:240,h:20},
  {x:560,y:120,w:240,h:20},
  {x:160,y:120,w:20,h:160},
  {x:780,y:120,w:20,h:160},
  {x:160,y:260,w:640,h:20},
  {x:320,y:260,w:20,h:160},
  {x:640,y:260,w:20,h:160},
  {x:160,y:420,w:240,h:20},
  {x:560,y:420,w:240,h:20},
];

// Task stations (static)
const tasks = [
  { id:'wires',   x:110, y:100,  label:'Wires' },
  { id:'engine',  x:850, y:100,  label:'Engine' },
  { id:'shields', x:110, y:450,  label:'Shields' },
  { id:'nav',     x:850, y:450,  label:'Navigation' },
  { id:'med',     x:490, y:340,  label:'Medbay' },
];

// Simple circle-rect collision
function circleRectCollide(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  return (dx*dx + dy*dy) <= r*r;
}

/* ===== WS handlers ===== */
ws.onmessage = (ev) => {
  const { type, payload } = JSON.parse(ev.data);

  if (type === 'roomCreated') {
    roomInput.value = payload.roomId;
    roomIdEl.textContent = payload.roomId;
  }

  if (type === 'joined') {
    myId = payload.playerId; currentRoomId = payload.roomId; isHost = payload.isHost;
    meEl.textContent = myId.slice(0,8);
    roomIdEl.textContent = currentRoomId;

    const snap = payload.snapshot || {};
    phase = snap.phase || 'lobby';
    sabotage = snap.sabotage || { type: null };
    tasksDone = snap.tasksDone || 0;
    tasksTotal = snap.totalTasks || 0;
    tasksDoneEl.textContent = tasksDone;
    tasksTotalEl.textContent = tasksTotal;
    phaseEl.textContent = phase;

    applyPlayers(snap.players || [], snap.hostId);
    showGameArea(true);
    if (phase === 'meeting') { buildVoteList(); showMeeting(true); stopVoice(); }
    refreshHudButtons();
  }

  if (type === 'players') applyPlayers(payload.players, payload.hostId);

  if (type === 'phase') {
    phase = payload.phase || phase; phaseEl.textContent = phase;
    sabotage = payload.sabotage || sabotage;
    tasksDone = payload.tasksDone ?? tasksDone;
    tasksTotal = payload.totalTasks ?? tasksTotal;
    tasksDoneEl.textContent = tasksDone;
    tasksTotalEl.textContent = tasksTotal;
    if (payload.players) applyPlayers(payload.players, payload.hostId);
    if (phase === 'meeting') { buildVoteList(); showMeeting(true); stopVoice(); }
    else { showMeeting(false); stopVoice(); }
    refreshHudButtons();
    if (phase === 'playing') hideVictory(); // new round
}

  if (type === 'pos') { const p = players.get(payload.id); if (p) { p.x = payload.x; p.y = payload.y; } }
  if (type === 'chat') appendChat(`<b>${escapeHtml(payload.from)}:</b> ${escapeHtml(payload.text)}`);
  if (type === 'expelled') appendChat(`System: ${escapeHtml(payload.name)} was ejected.`);
  if (type === 'role') { myRole = payload.role; roleEl.textContent = myRole==='sab'?'Saboteur':'Crew'; refreshHudButtons(); }
  if (type === 'killed') { const p = players.get(payload.targetId); if (p) p.alive = false; refreshHudButtons(); }
  if (type === 'sabotage' || type === 'sabotageUpdate') { sabotage = payload; refreshHudButtons(); }
  if (type === 'tasks') { tasksDone = payload.tasksDone; tasksTotal = payload.totalTasks; tasksDoneEl.textContent = tasksDone; tasksTotalEl.textContent = tasksTotal; }

 if (type === 'gameEnded') {
  console.log('[WS] gameEnded', payload); // debug
  appendChat(`🏁 Game Over: ${payload.winner.toUpperCase()} win.`);
  phase = 'ended';
  phaseEl.textContent = 'ended';
  showMeeting(false);
  stopVoice();
  refreshHudButtons();
  showVictory(payload.winner);   // <-- show banner
}


  if (type === 'rtc') handleRTC(payload);
};

function ensureVictoryOverlay() {
  let v = document.getElementById('victory');
  if (v) return; // already exists

  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.id = 'victory';
  wrap.style.display = 'none';
  wrap.style.pointerEvents = 'auto';
  wrap.style.zIndex = '9999';

  wrap.innerHTML = `
    <div class="panel" style="text-align:center">
      <h2 id="victoryMsg">Game Over</h2>
      <p class="muted" id="victorySub">Thanks for playing!</p>
      <div class="row" style="justify-content:center;margin-top:10px">
        <button class="btn" id="btnPlayAgain">Return to Lobby</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  document.getElementById('btnPlayAgain').onclick = () => location.reload();
}

function showVictory(winner){
  ensureVictoryOverlay();
  const v  = document.getElementById('victory');
  const h2 = document.getElementById('victoryMsg');
  const p  = document.getElementById('victorySub');
  const crewWin = (winner === 'crew');
  h2.textContent = crewWin ? '🎉 Crew Victory!' : '💀 Saboteurs Win!';
  p.textContent  = crewWin
    ? 'All tasks were completed or all saboteurs were eliminated.'
    : 'Saboteurs reached parity or a sabotage succeeded.';
  v.style.display = 'grid';
}

function hideVictory(){
  const v = document.getElementById('victory');
  if (v) v.style.display = 'none';
}




/* ===== UI ===== */
btnCreate.onclick = () => {
  if (ws.readyState !== 1) return alert('Connecting to server…');
  ws.send(JSON.stringify({ type:'createRoom' }));
};
btnJoin.onclick = () => {
  const name  = (nameInput.value || 'Player').trim();
  const roomId= (roomInput.value || '').trim().toUpperCase();
  const color = (colorInput.value || '#7dd3fc').trim();
  const hat   = (hatInput.value || 'none');
  const skin  = (skinInput.value || 'none');
  if (!roomId) return alert('Enter a room code');
  ws.send(JSON.stringify({ type:'join', payload:{ roomId, name, color, hat, skin } }));
};
btnStart.onclick = () => ws.send(JSON.stringify({ type:'startGame' }));

btnReport.onclick   = () => { if (phase==='playing') ws.send(JSON.stringify({ type:'report' })); };
btnEmergency.onclick= () => { if (phase==='playing') ws.send(JSON.stringify({ type:'callMeeting' })); };

btnKill.onclick = () => {
  if (phase!=='playing' || myRole!=='sab') return;
  const victim = nearestVictim(120);
  if (victim) ws.send(JSON.stringify({ type:'kill', payload:{ targetId: victim.id } }));
};

btnSabotage.onclick = () => {
  if (phase!=='playing' || myRole!=='sab' || sabotage.type) return;
  const kind = prompt("Type 'lights' or 'o2' to sabotage:", "lights");
  if (!kind) return;
  ws.send(JSON.stringify({ type:'sabotage', payload:{ kind: kind.toLowerCase()==='o2'?'o2':'lights' } }));
};

btnFix.onclick = () => {
  if (phase!=='playing' || !sabotage.type) return;
  if (sabotage.type==='lights') ws.send(JSON.stringify({ type:'fixSabotage' }));
  else if (sabotage.type==='o2') {
    const side = prompt("Fix O₂: type 'left' or 'right'", "left");
    ws.send(JSON.stringify({ type:'fixSabotage', payload:{ side: (side||'left').toLowerCase()==='right'?'right':'left' } }));
  }
};

voteSkip.onclick = () => { if (phase==='meeting') ws.send(JSON.stringify({ type:'vote', payload:{ targetId:null } })); };
chatInput?.addEventListener('keydown', e => {
  if (e.key==='Enter' && phase==='meeting' && isMeAlive()) {
    const t = chatInput.value.trim(); chatInput.value = '';
    if (t) ws.send(JSON.stringify({ type:'chat', payload:{ text:t } }));
  }
});

/* ===== Helpers ===== */
function applyPlayers(list, hostId) {
  players = new Map(list.map(p => [p.id, { ...p }]));
  hostEl.textContent = hostId ? hostId.slice(0,8) : '-';
  btnStart.disabled = !isHost;
  renderPlayers();
  refreshHudButtons();
}
function renderPlayers() {
  if (players.size===0) { playersEl.textContent='none'; return; }
  playersEl.innerHTML = [...players.values()]
    .map(p=>`<span class="pill" style="border-color:${p.color||'#444'}">${escapeHtml(p.name)} <span class="muted">(${p.alive?'alive':'dead'})</span></span>`)
    .join(' ');
}
function isMeAlive(){ const me = players.get(myId); return !!(me && me.alive); }
function refreshHudButtons(){
  const meAlive = isMeAlive();
  const canPlay = phase==='playing' && meAlive;
  btnReport.disabled = !canPlay;
  btnEmergency.disabled = !(phase==='playing');
  btnKill.disabled = !(canPlay && myRole==='sab');
  btnSabotage.disabled = !(canPlay && myRole==='sab' && !sabotage.type);
  btnFix.disabled = !(canPlay && !!sabotage.type);
  chatInput.disabled = !(phase==='meeting' && meAlive);
  chatInput.placeholder = (phase==='meeting' && !meAlive) ? 'Dead players cannot chat' : 'Type to chat…';
  vcJoin.disabled = !(phase==='meeting' && meAlive); vcLeave.disabled = true; vcMute.disabled = true;
}
function showGameArea(show){ gameWrap.style.display = show?'block':'none'; }
function showMeeting(show){ meeting.style.display = show?'grid':'none'; if (show) chatBox.innerHTML=''; }
function buildVoteList(){
  voteList.innerHTML = '';
  for (const p of players.values()) {
    const b = document.createElement('button');
    b.textContent = `${p.name} ${p.alive?'':'(dead)'}`;
    b.className = 'btn';
    b.disabled = !p.alive || !isMeAlive();
    b.onclick = () => ws.send(JSON.stringify({ type:'vote', payload:{ targetId:p.id } }));
    voteList.appendChild(b);
  }
}

/* ===== Voice (meetings only & alive-only) ===== */
vcJoin.onclick = async () => {
  if (vcJoin.disabled) return;
  try { if (!mediaStream) mediaStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false }); }
  catch { alert('Mic permission denied'); return; }
  startVoice();
};
vcMute.onclick = () => {
  if (!mediaStream) return;
  micEnabled = !micEnabled;
  for (const t of mediaStream.getAudioTracks()) t.enabled = micEnabled;
  vcMute.textContent = micEnabled ? 'Mute' : 'Unmute';
};
vcLeave.onclick = () => stopVoice();

function startVoice(){
  vcJoin.disabled = true; vcLeave.disabled = false; vcMute.disabled = true;
  for (const p of players.values()){
    if (p.id===myId || !p.alive) continue;
    callPeer(p.id);
  }
}
function stopVoice(){
  vcJoin.disabled = !(phase==='meeting' && isMeAlive());
  vcLeave.disabled = true; vcMute.disabled = true;
  for (const pc of peers.values()) try{ pc.close(); }catch{}
  peers.clear(); voicePeers.innerHTML = '';
}
function callPeer(peerId){
  if (peers.has(peerId)) return peers.get(peerId);
  const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });
  peers.set(peerId, pc);
  if (mediaStream){ mediaStream.getAudioTracks().forEach(t=>pc.addTrack(t, mediaStream)); vcMute.disabled=false; }
  pc.onicecandidate = e => { if (e.candidate) ws.send(JSON.stringify({ type:'rtc', payload:{ to:peerId, kind:'ice', candidate:e.candidate } })); };
  pc.ontrack = e => addPeerAudio(peerId, e.streams[0]);
  pc.onconnectionstatechange = () => { if (['disconnected','failed','closed'].includes(pc.connectionState)){ removePeerAudio(peerId); peers.delete(peerId); } };
  (async()=>{ const offer=await pc.createOffer(); await pc.setLocalDescription(offer); ws.send(JSON.stringify({ type:'rtc', payload:{ to:peerId, kind:'offer', sdp:offer } })); })();
  return pc;
}
async function handleRTC(msg){
  const from = msg.from;
  if (phase!=='meeting' || !isMeAlive()) return;
  if (msg.kind==='offer'){
    const pc = callPeer(from);
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type:'rtc', payload:{ to:from, kind:'answer', sdp:answer } }));
  } else if (msg.kind==='answer'){
    const pc = peers.get(from); if (pc) await pc.setRemoteDescription(msg.sdp);
  } else if (msg.kind==='ice'){
    const pc = peers.get(from); if (pc) try{ await pc.addIceCandidate(msg.candidate); } catch{}
  }
}
function addPeerAudio(id, stream){
  let tag = document.getElementById('peer-'+id);
  if (!tag){ tag=document.createElement('div'); tag.id='peer-'+id; tag.className='pill'; tag.textContent='Voice: '+(players.get(id)?.name||id.slice(0,6)); voicePeers.appendChild(tag); }
  let el = document.getElementById('audio-'+id);
  if (!el){ el=document.createElement('audio'); el.id='audio-'+id; el.autoplay=true; el.playsInline=true; document.body.appendChild(el); }
  el.srcObject = stream;
}
function removePeerAudio(id){
  document.getElementById('peer-'+id)?.remove();
  const el=document.getElementById('audio-'+id); if (el){ try{ el.srcObject=null; el.remove(); } catch{} }
}

/* ===== Movement + Anim + Tasks ===== */
addEventListener('keydown', e => keys.add(e.key.toLowerCase()));
addEventListener('keyup',   e => keys.delete(e.key.toLowerCase()));
addEventListener('keypress', e => {
  if (e.key.toLowerCase() === 'e') tryDoTask();
});

function update(dt){
  if (phase!=='playing') return;
  timeSec += dt;

  const me = players.get(myId);
  if (!me || !me.alive) return;

  const speed = 230;
  let dx=0, dy=0;
  if (keys.has('a')||keys.has('arrowleft'))  dx-=1;
  if (keys.has('d')||keys.has('arrowright')) dx+=1;
  if (keys.has('w')||keys.has('arrowup'))    dy-=1;
  if (keys.has('s')||keys.has('arrowdown'))  dy+=1;

  if (dx||dy){
    const len = Math.hypot(dx,dy)||1;
    const nx = me.x + (dx/len)*speed*dt;
    const ny = me.y + (dy/len)*speed*dt;
    const r = 14;

    // collision: reject move if collides any wall
    if (!walls.some(w => circleRectCollide(nx, ny, r, w))) {
      me.x = Math.max(20, Math.min(canvas.width-20, nx));
      me.y = Math.max(20, Math.min(canvas.height-20, ny));
      const now = performance.now();
      if (now - lastSent > 66) {
        ws.send(JSON.stringify({ type:'move', payload:{ x:Math.round(me.x), y:Math.round(me.y) } }));
        lastSent = now;
      }
    }
  }

  // Show task hint if near
  const near = nearestTask(me.x, me.y, 40);
  if (near && myRole === 'crew' && !myCompletedTasks.has(near.id)) {
    taskHintEl.textContent = `Press E to do task: ${near.label}`;
  } else {
    taskHintEl.textContent = '';
  }
}

function draw(){
  // background
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = '#0b1226';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  for (let x=0; x<canvas.width; x+=40){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
  for (let y=0; y<canvas.height; y+=40){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }

  // walls
  ctx.fillStyle = '#141c32';
  walls.forEach(r => ctx.fillRect(r.x, r.y, r.w, r.h));

  // tasks
  for (const t of tasks) {
    ctx.fillStyle = '#facc15';
    ctx.beginPath(); ctx.arc(t.x, t.y, 8, 0, Math.PI*2); ctx.fill();
    ctx.font='12px sans-serif'; ctx.fillStyle='#e5e7eb'; ctx.textAlign='center';
    ctx.fillText(t.label, t.x, t.y - 12);
  }

  // phase/sabo
  ctx.fillStyle='rgba(255,255,255,.75)'; ctx.font='14px sans-serif'; ctx.textAlign='left';
  let label = 'Phase: ' + phase;
  if (sabotage.type==='lights') label+=' — Lights OFF';
  if (sabotage.type==='o2') label+=' — O₂ in danger!';
  ctx.fillText(label, 12, 20);

  // players
  for (const p of players.values()) {
    const moving = (p.id===myId) ? (keys.has('w')||keys.has('a')||keys.has('s')||keys.has('d')||keys.has('arrowup')||keys.has('arrowdown')||keys.has('arrowleft')||keys.has('arrowright')) : false;
    const bob = moving ? Math.sin(timeSec*10)*1.2 : Math.sin(timeSec*2)*0.6;
    drawAstronaut(p.x, p.y + bob, p.color || '#7dd3fc', p.id===myId, !p.alive, p.hat, p.skin, moving ? timeSec : 0);
    ctx.fillStyle='rgba(255,255,255,.9)'; ctx.font='12px sans-serif'; ctx.textAlign='center';
    ctx.fillText(p.name, p.x, p.y - 28);
  }
}

/* ===== Tasks ===== */
function nearestTask(x,y,r) {
  let best=null, bestD=Infinity;
  for (const t of tasks) {
    const dx=t.x-x, dy=t.y-y, d2=dx*dx+dy*dy;
    if (d2<r*r && d2<bestD){ best=t; bestD=d2; }
  }
  return best;
}
let doingTask = null; // {id,label,progress}
function tryDoTask(){
  if (phase!=='playing' || myRole!=='crew') return;
  const me = players.get(myId); if (!me || !me.alive) return;
  const t = nearestTask(me.x, me.y, 40);
  if (!t || myCompletedTasks.has(t.id)) return;

  // simple 2-second hold mini-task
  doingTask = { id:t.id, label:t.label, progress:0 };
}
function drawTaskOverlay(){
  if (!doingTask) return;
  // advance progress while E is held
  const holding = keys.has('e');
  doingTask.progress += holding ? 0.02 : -0.03;
  doingTask.progress = Math.max(0, Math.min(1, doingTask.progress));

  // overlay
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px sans-serif'; ctx.textAlign='center';
  ctx.fillText(`Task: ${doingTask.label} — Hold E`, canvas.width/2, canvas.height/2 - 30);

  // bar
  const bw=320, bh=16, bx=canvas.width/2 - bw/2, by=canvas.height/2;
  ctx.fillStyle='#1f2937'; ctx.fillRect(bx,by,bw,bh);
  ctx.fillStyle='#22c55e'; ctx.fillRect(bx,by,bw*doingTask.progress,bh);
  ctx.strokeStyle='#ffffff'; ctx.strokeRect(bx,by,bw,bh);
  ctx.restore();

  if (doingTask.progress >= 1) {
    // finished
    myCompletedTasks.add(doingTask.id);
    ws.send(JSON.stringify({ type:'taskComplete', payload:{ taskId: doingTask.id } }));
    doingTask = null;
  }
}

/* ===== Astronaut drawing with hats/skins & walk cycle ===== */
function drawAstronaut(x, y, color, isMe, isDead, hat='none', skin='none', t=0){
  ctx.save();
  ctx.translate(x, y);

  // walk cycle (simple leg swing)
  const swing = t ? Math.sin(t*10) : 0;
  const body = color;
  const outline = isDead ? 'rgba(255,91,110,.7)' : 'rgba(0,0,0,.35)';

  // shadow
  ctx.globalAlpha = 0.25;
  ctx.beginPath(); ctx.ellipse(0, 16, 12, 5, 0, 0, Math.PI*2); ctx.fillStyle = '#000'; ctx.fill();
  ctx.globalAlpha = 1;

  // backpack
  ctx.fillStyle = shade(body, -18);
  roundRect(-14, -10, 8, 18, 3, true);

  // body
  ctx.fillStyle = body;
  roundRect(-10, -16, 22, 28, 10, true);
  ctx.strokeStyle = outline; ctx.lineWidth = 2; roundRect(-10, -16, 22, 28, 10, false);

  // skin overlays
  if (skin === 'stripe') {
    ctx.fillStyle = shade(body, -30);
    roundRect(-10, -2, 22, 6, 3, true);
  } else if (skin === 'overalls') {
    ctx.fillStyle = shade(body, -35);
    roundRect(-10, 0, 22, 12, 4, true);
  } else if (skin === 'suit') {
    ctx.strokeStyle = shade('#ffffff', -120);
    ctx.beginPath(); ctx.moveTo(-6, -6); ctx.lineTo(0, 2); ctx.lineTo(6,-6); ctx.stroke();
  }

  // legs with swing
  ctx.fillStyle = shade(body, -10);
  roundRect(-8, 8 + swing*1.2, 8, 8, 3, true);
  roundRect( 2, 8 - swing*1.2, 8, 8, 3, true);

  // visor
  ctx.fillStyle = isMe ? '#c4f1ff' : '#bfe6ff';
  ctx.beginPath(); ctx.ellipse(2, -6, 8.5, 6.5, 0.05, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(2, -6, 8.5, 6.5, 0.05, 0, Math.PI*2); ctx.stroke();

  // hats
  if (hat === 'cap') {
    ctx.fillStyle = shade(body, -35);
    roundRect(-6, -22, 14, 6, 3, true); // cap
    ctx.fillRect(4, -18, 10, 3); // brim
  } else if (hat === 'crown') {
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(-8, -18); ctx.lineTo(-4, -25); ctx.lineTo(0, -18); ctx.lineTo(4, -25); ctx.lineTo(8, -18);
    ctx.closePath(); ctx.fill();
  } else if (hat === 'flower') {
    ctx.fillStyle = '#84cc16';
    ctx.fillRect(-2, -22, 3, 6);
    ctx.fillStyle = '#f472b6';
    for (let i=0;i<5;i++){ const a=i*1.256; ctx.beginPath(); ctx.arc(-2+Math.cos(a)*5, -24+Math.sin(a)*5, 3, 0, Math.PI*2); ctx.fill(); }
    ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(-2, -24, 2.5, 0, Math.PI*2); ctx.fill();
  } else if (hat === 'visor') {
    ctx.strokeStyle = '#9ca3af';
    ctx.beginPath(); ctx.arc(2, -6, 10, Math.PI*1.1, Math.PI*1.9); ctx.stroke();
  }

  ctx.restore();
}

function roundRect(x,y,w,h,r,fill){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  fill ? ctx.fill() : ctx.stroke();
}
function shade(hex, amt){
  hex = hex.replace('#','');
  const num = parseInt(hex,16);
  let r=(num>>16)+amt, g=(num>>8 & 0xff)+amt, b=(num & 0xff)+amt;
  r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
  return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
}

/* ===== Loop ===== */
let last = performance.now();
function loop(t){
  const dt = Math.min((t - last)/1000, 1/30);
  last = t;
  update(dt);
  draw();
  drawTaskOverlay();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ===== Utils ===== */
function escapeHtml(s){ return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function appendChat(html){ const div=document.createElement('div'); div.innerHTML=html; chatBox.appendChild(div); chatBox.scrollTop=chatBox.scrollHeight; }
function nearestVictim(r){
  const me = players.get(myId); if (!me) return null;
  let best=null, bestD=Infinity;
  for (const p of players.values()){
    if (p.id===myId || !p.alive) continue;
    const dx=p.x-me.x, dy=p.y-me.y, d2=dx*dx+dy*dy;
    if (d2<r*r && d2<bestD){ best=p; bestD=d2; }
  }
  return best;
}
