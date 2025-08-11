// client.js — adds colored astronauts; keeps meetings/chat/voice/roles/etc.
const $ = sel => document.querySelector(sel);

const nameInput = $('#name');
const roomInput = $('#room');
const colorInput = $('#color');

const btnCreate = $('#create');
const btnJoin = $('#join');
const btnStart = $('#start');

const roomIdEl = $('#roomId');
const meEl = $('#me');
const hostEl = $('#host');
const playersEl = $('#players');
const phaseEl = $('#phase');
const roleEl = $('#role');

const btnReport = $('#btnReport');
const btnEmergency = $('#btnEmergency');
const btnKill = $('#btnKill');
const btnSabotage = $('#btnSabotage');
const btnFix = $('#btnFix');

const gameWrap = document.getElementById('gameWrap');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const meeting = $('#meeting');
const voteList = $('#voteList');
const chatBox = $('#chat');
const chatInput = $('#chatInput');
const voteSkip = $('#voteSkip');

const vcJoin = $('#vcJoin');
const vcMute = $('#vcMute');
const vcLeave = $('#vcLeave');
const voicePeers = $('#voicePeers');

const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host);
// Show connection status in the page title area
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

ws.addEventListener('open',   () => { console.log('[WS] open');   updateWsBadge(); });
ws.addEventListener('close',  (e) => { console.log('[WS] close', e.code, e.reason); updateWsBadge(); });
ws.addEventListener('error',  (e) => { console.error('[WS] error', e); updateWsBadge(); });

// If you want to see all messages:
ws.addEventListener('message', (e)=>{ /* console.log('[WS] msg', e.data); */ });
updateWsBadge();


let myId = null, currentRoomId = null, isHost = false;
let phase = 'lobby';
let myRole = 'unknown';
let sabotage = { type: null };
let players = new Map(); // id -> {id,name,x,y,alive,color,role}

const keys = new Set();
let lastSent = 0;

// Voice
const peers = new Map();
let mediaStream = null;
let micEnabled = true;

/* ===== WS ===== */
ws.onmessage = (ev) => {
  const { type, payload } = JSON.parse(ev.data);

  if (type === 'roomCreated') {
    roomInput.value = payload.roomId;
    roomIdEl.textContent = payload.roomId;
  }

  if (type === 'joined') {
    myId = payload.playerId; currentRoomId = payload.roomId; isHost = payload.isHost;
    meEl.textContent = myId.slice(0, 8);
    roomIdEl.textContent = currentRoomId;

    phase = payload.snapshot.phase || 'lobby';
    sabotage = payload.snapshot.sabotage || { type: null };
    phaseEl.textContent = phase;

    applyPlayers(payload.snapshot.players, payload.snapshot.hostId);
    showGameArea(true);
    if (phase === 'meeting') { buildVoteList(); showMeeting(true); stopVoice(); }
    refreshHudButtons();
  }

  if (type === 'players') applyPlayers(payload.players, payload.hostId);

  if (type === 'phase') {
    phase = payload.phase || phase; phaseEl.textContent = phase;
    sabotage = payload.sabotage || sabotage;
    if (payload.players) applyPlayers(payload.players, payload.hostId);
    if (phase === 'meeting') { buildVoteList(); showMeeting(true); stopVoice(); }
    else { showMeeting(false); stopVoice(); }
    refreshHudButtons();
  }

  if (type === 'pos') { const p = players.get(payload.id); if (p) { p.x = payload.x; p.y = payload.y; } }
  if (type === 'chat') appendChat(`<b>${escapeHtml(payload.from)}:</b> ${escapeHtml(payload.text)}`);
  if (type === 'expelled') appendChat(`System: ${escapeHtml(payload.name)} was ejected.`);
  if (type === 'role') { myRole = payload.role; roleEl.textContent = myRole==='sab'?'Saboteur':'Crew'; refreshHudButtons(); }
  if (type === 'killed') { const p = players.get(payload.targetId); if (p) p.alive = false; refreshHudButtons(); }
  if (type === 'sabotage' || type === 'sabotageUpdate') { sabotage = payload; refreshHudButtons(); }
  if (type === 'gameEnded') { appendChat(`🏁 Game Over: ${payload.winner.toUpperCase()} win.`); phase='ended'; phaseEl.textContent='ended'; refreshHudButtons(); showMeeting(false); stopVoice(); }

  if (type === 'rtc') handleRTC(payload);
};

/* ===== UI ===== */
btnCreate.onclick = () => ws.send(JSON.stringify({ type:'createRoom' }));
btnJoin.onclick = () => {
  const name = (nameInput.value || 'Player').trim();
  const roomId = (roomInput.value || '').trim().toUpperCase();
  const color = (colorInput.value || '#7dd3fc').trim();
  if (!roomId) { alert('Enter a room code'); return; }
  ws.send(JSON.stringify({ type:'join', payload:{ roomId, name, color } }));
};
btnStart.onclick = () => ws.send(JSON.stringify({ type:'startGame' }));

btnReport.onclick = () => { if (phase==='playing') ws.send(JSON.stringify({ type:'report' })); };
btnEmergency.onclick = () => { if (phase==='playing') ws.send(JSON.stringify({ type:'callMeeting' })); };

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

/* ===== Voice (unchanged rules: meeting & alive only) ===== */
const peers = new Map();
let mediaStream = null, micEnabled = true;

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

/* ===== Movement + Draw (astronauts!) ===== */
addEventListener('keydown', e => keys.add(e.key.toLowerCase()));
addEventListener('keyup',   e => keys.delete(e.key.toLowerCase()));

function update(dt){
  if (phase!=='playing') return;
  const me = players.get(myId); if (!me || !me.alive) return;
  const speed=220; let dx=0, dy=0;
  if (keys.has('a')||keys.has('arrowleft')) dx-=1;
  if (keys.has('d')||keys.has('arrowright')) dx+=1;
  if (keys.has('w')||keys.has('arrowup'))   dy-=1;
  if (keys.has('s')||keys.has('arrowdown')) dy+=1;
  if (dx||dy){
    const len=Math.hypot(dx,dy)||1;
    me.x+=(dx/len)*speed*dt; me.y+=(dy/len)*speed*dt;
    me.x=Math.max(20,Math.min(980,me.x)); me.y=Math.max(20,Math.min(580,me.y));
    const now=performance.now();
    if (now-lastSent>66){ ws.send(JSON.stringify({ type:'move', payload:{ x:Math.round(me.x), y:Math.round(me.y) } })); lastSent=now; }
  }
}

function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#0c1124'; ctx.fillRect(0,0,canvas.width,canvas.height);

  ctx.strokeStyle='rgba(255,255,255,.06)';
  for (let x=0;x<canvas.width;x+=40){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
  for (let y=0;y<canvas.height;y+=40){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }

  ctx.fillStyle='rgba(255,255,255,.75)'; ctx.font='14px sans-serif';
  let label='Phase: '+phase; if (sabotage.type==='lights') label+=' — Lights OFF'; if (sabotage.type==='o2') label+=' — O₂ in danger!';
  ctx.fillText(label, 12, 20);

  for (const p of players.values()) {
    drawAstronaut(p.x, p.y, p.color || '#7dd3fc', p.id===myId, !p.alive);
    ctx.fillStyle='rgba(255,255,255,.9)';
    ctx.font='12px sans-serif'; ctx.textAlign='center';
    ctx.fillText(p.name, p.x, p.y - 24);
  }
}

/* cute astronaut: body capsule, visor, backpack; darker outline if dead */
function drawAstronaut(x, y, color, isMe, isDead){
  const body = color;
  const outline = isDead ? 'rgba(255,91,110,.7)' : 'rgba(0,0,0,.35)';
  ctx.save();
  ctx.translate(x, y);

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

  // legs (simple)
  ctx.fillStyle = shade(body, -10);
  roundRect(-8, 8, 8, 8, 3, true);
  roundRect(2, 8, 8, 8, 3, true);

  // visor
  ctx.fillStyle = isMe ? '#c4f1ff' : '#bfe6ff';
  ctx.beginPath(); ctx.ellipse(2, -6, 8.5, 6.5, 0.05, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(2, -6, 8.5, 6.5, 0.05, 0, Math.PI*2); ctx.stroke();

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
function shade(hex, amt){ // quick hex shade
  hex = hex.replace('#','');
  const num = parseInt(hex,16);
  let r=(num>>16)+amt, g=(num>>8 & 0xff)+amt, b=(num & 0xff)+amt;
  r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
  return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
}

/* loop */
let last = performance.now();
function loop(t){ const dt=Math.min((t-last)/1000,1/30); last=t; update(dt); draw(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);

/* utils */
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
