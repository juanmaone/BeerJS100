// ══════════ CONFIG ══════════
// BOTANICAL_CONFIG se carga desde config.js (script tag anterior)
const CFG = (typeof BOTANICAL_CONFIG !== 'undefined') ? BOTANICAL_CONFIG : {
  claudeApiKey: '',
  claudeModel:  'anthropic/claude-haiku-4.5',
  mqttWsUrl:    'ws://localhost:9001',
  mqttUser:     '',
  mqttPass:     '',
  umbralSueloBajo: 25,
  umbralTempAlta:  35,
  umbralTempBaja:  10,
  umbralProxCm:    60,
};

// ══════════ ESTADO ══════════
const S = {
  temp:0, hum:0, soil:0, dist:0,
  riegos:0, historial:[], visits:[], visitCount:0, minDist:999,
  state:'idle', speaking:false, voiceEnabled:true,
  waterTimer:null, lastGreetTime:0, lastStateMsgTime:0, lastVisitTime:0, mqttConnected:false
};
const NEAR_CM = CFG.umbralProxCm || 60;
const GREET_CD = 4 * 60 * 60 * 1000;
const STATE_MSG_CD = 60 * 1000;
const VISIT_CD = 15 * 1000;
let proxNear = false, proxNearStart = null;
let animFrame = null, blinkIv = null, particleIv = null, shakeIv = null;
const chatHistory = [];
let msgIndex = 1;

// ══════════ MQTT WEBSOCKET ══════════
let mqttClient = null;

function initMQTT() {
  updateConnBadge('connecting');
  const opts = { clientId: 'botanical-twin-browser-' + Math.random().toString(16).slice(2) };
  if (CFG.mqttUser) { opts.username = CFG.mqttUser; opts.password = CFG.mqttPass; }

  mqttClient = mqtt.connect(CFG.mqttWsUrl, opts);

  mqttClient.on('connect', () => {
    S.mqttConnected = true;
    updateConnBadge('online');
    console.log('[MQTT] Conectado a', CFG.mqttWsUrl);
    mqttClient.subscribe(['jardin/sensores','jardin/alertas','jardin/eventos','jardin/proximidad']);
    mqttLog('jardin/$SYS','{"estado":"browser_conectado"}','sub');
  });

  mqttClient.on('error',     e  => { updateConnBadge('error');   console.error('[MQTT]', e.message); });
  mqttClient.on('reconnect', () => { updateConnBadge('connecting'); });
  mqttClient.on('offline',   () => { S.mqttConnected=false; updateConnBadge('offline'); });

  mqttClient.on('message', (topic, raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (topic === 'jardin/sensores') {
      const r = {
        temp:  Number(data.temp ?? S.temp),
        hum:   Number(data.hum ?? S.hum),
        soil:  Number(data.suelo ?? data.soil ?? S.soil),
        dist:  Number(data.dist ?? data.prox ?? data.distancia_cm ?? data.distancia ?? S.dist),
        ts: new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
      };
      S.temp=r.temp; S.hum=r.hum; S.soil=r.soil; S.dist=r.dist;
      S.historial.push(r); if(S.historial.length>60) S.historial.shift();
      renderSensors(r); decideState(r); drawSpark();
      mqttLog('jardin/sensores', raw.toString(), 'pub');
      document.getElementById('footer-time').textContent = new Date().toLocaleTimeString('es-AR');
    }

    if (topic === 'jardin/alertas') {
      mqttLog('jardin/alertas', raw.toString(), 'alert');
    }

    if (topic === 'jardin/eventos') {
      mqttLog('jardin/eventos', raw.toString(), 'sub');
      if (data.evento === 'riego_completado') {
        clearInterval(S.waterTimer); S.waterTimer=null;
        setTimeout(()=>applyState('idle'), 1200);
      }
      if (data.evento === 'persona_detectada') {
        onPersonNear(data.distancia ?? 40);
      }
    }

    if (topic === 'jardin/proximidad') {
      mqttLog('jardin/proximidad', raw.toString(), 'prox');
      const dist = Number(data.distancia_cm ?? data.dist ?? data.prox ?? 0);
      if (dist > 0) {
        const rr = { temp:S.temp, hum:S.hum, soil:S.soil, dist, ts: new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) };
        S.dist = dist;
        renderSensors(rr);
      }
      if (data.cerca) onPersonNear(dist || 50);
    }
  });
}

function updateConnBadge(status) {
  const b = document.getElementById('hbadge-mqtt');
  if (!b) return;
  const labels = { online:'MQTT · Online', connecting:'MQTT · Conectando…', offline:'MQTT · Offline', error:'MQTT · Error' };
  const colors = { online:'var(--blue)', connecting:'var(--gold2)', offline:'var(--terra)', error:'var(--terra)' };
  b.textContent = labels[status] || status;
  b.style.color = colors[status] || 'var(--ink4)';
}

function pubMQTT(topic, payload) {
  if (mqttClient && S.mqttConnected) {
    mqttClient.publish(topic, JSON.stringify(payload));
  }
}

// ══════════ FRASES ══════════
function period() {
  const h = new Date().getHours();
  return h < 12 ? 'mañana' : h < 19 ? 'tarde' : 'noche';
}
const GREETS = {
  mañana:['¡Buenos días! La luz matinal me nutre. ¿Cómo amaneciste?','¡Buen día! Mis hojas ya absorben los primeros fotones del alba.'],
  tarde:['¡Buenas tardes! La fotosíntesis está en pleno apogeo.','¡Hola! Qué bueno que pasaste. Las tardes son mi momento favorito.'],
  noche:['¡Buenas noches! Ya bajo mi metabolismo, pero me alegra verte.','¡Hola nocturno! A esta hora descanso mis procesos celulares.']
};
const STATE_SAY = {
  hot:['¡Uf, calor insoportable! ¡Transpiro como si fuera el Sahara! 😰','¡Sácame del sol, por favor! ¡Me derrito!'],
  cold:['B-b-brrrr... ¡Me congelo las raíces! ❄️','¡Frío terrible! ¡Cierren esa ventana!'],
  thirsty:['¡Agua, por favor! ¡Mi suelo está reseco! 🏜️','¡Días sin agua! ¡Mis raíces imploran!'],
  watered:['¡Ahhh, delicia! ¡Renazco con cada gota! 💧','¡Gracias! ¡Exactamente lo que necesitaba!'],
  idle:['Todo en orden. Temperatura y humedad en rangos normales.','Absorbiendo nutrientes tranquilamente. Todo bien.']
};
const rand = a => a[Math.floor(Math.random()*a.length)];

function oracleStateText(state) {
  const t = Number.isFinite(S.temp) ? S.temp.toFixed(1) : "--";
  const soil = Number.isFinite(S.soil) ? Math.round(S.soil) : "--";

  const lines = {
    idle: [
      "El invernadero sigue su geometria serena; las variables respiran en equilibrio.",
      "En este instante, el jardin no se bifurca: temperatura y humedad avanzan en orden.",
      "Las magnitudes se sostienen en una calma exacta; el suelo y el aire no discuten."
    ],
    hot: [
      `A ${t}°C, la planta roza un mediodia excesivo; conviene regalarle sombra.`,
      `El calor asciende hasta ${t}°C y el tallo siente el rigor del verano.`,
      `La temperatura, en ${t}°C, exige prudencia hidrica y un margen de sombra.`
    ],
    cold: [
      `Con ${t}°C, el metabolismo se vuelve lento, como un pasillo en penumbra.`,
      `El frio marca ${t}°C; la planta pide resguardo y paciencia.`,
      `A ${t}°C, la savia avanza despacio; protege el entorno termico.`
    ],
    thirsty: [
      `El suelo, en ${soil}%, insinua sed: conviene un riego breve y atento.`,
      `Con humedad de suelo en ${soil}%, las raices buscan agua en silencio.`,
      `El sustrato marca ${soil}% y reclama una correccion hidrica urgente.`
    ],
    watered: [
      "El riego concluyo: el suelo recompone su memoria de agua.",
      "La hidratacion fue aplicada; ahora toca observar absorcion y deriva.",
      "Tras el riego, el sistema entra en reposo y espera la respuesta del sustrato."
    ],
    greeting: [
      "Una presencia cruza el umbral del laberinto; el gemelo responde.",
      "La distancia se acorta y la planta reconoce al visitante.",
      "El sensor confirma cercania; comienza el saludo del invernadero."
    ],
    talking: [
      "El oraculo botánico habla y traduce cifras en relato.",
      "La voz del gemelo convierte telemetria en consejo.",
      "En este momento, el sistema articula su estado en palabras."
    ]
  };

  return rand(lines[state] || ["El archivo botanico guarda silencio."]);
}

function oracleAnnotTemp(temp) {
  if (temp > 34) return rand(["El sol domina el plano", "La cupula termica aprieta", "Calor en ascenso sobre el jardin"]);
  if (temp < 12) return rand(["Frio en los corredores", "La noche enfria la savia", "Termica baja en el laberinto"]);
  return rand(["Modulor optimo", "Geometria termica estable", "Rango de confort vegetal"]);
}

function oracleAnnotHum(hum) {
  if (hum > 80) return rand(["Aire cargado de humedad", "Atmosfera densa y humeda", "Terracota saturada"]);
  if (hum < 30) return rand(["Aire seco en la camara", "Humedad tenue, borde arido", "Balance seco"]);
  return rand(["Terracota balance", "Higrometria en orden", "Pulso de aire estable"]);
}

function oracleAnnotSoil(soil) {
  if (soil < 25) return rand(["El desierto aguarda", "Raices piden agua", "Sustrato en umbral seco"]);
  if (soil > 80) return rand(["Saturacion total", "Sustrato cargado", "Exceso hidrico potencial"]);
  return rand(["Equilibrio hidrico", "Sustrato en balance", "Humedad de suelo estable"]);
}

function oracleAnnotMotion(active) {
  return active
    ? rand(["Movimiento en el laberinto", "Un visitante roza el umbral", "Presencia confirmada por distancia"])
    : rand(["Sin movimiento cercano", "El corredor permanece vacio", "Ningun visitante en rango"]);
}

// ══════════ TTS ══════════
let voiceTo = null;
function speak(text, force=false) {
  if (!S.voiceEnabled && !force) return;
  if (!text) text = rand(STATE_SAY[S.state] || STATE_SAY.idle);
  window.speechSynthesis.cancel(); clearTimeout(voiceTo);
  showBubble(text); setBodyState('talking');
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang='es-AR'; utt.rate=0.92; utt.pitch=1.08; utt.volume=1;
  const v = speechSynthesis.getVoices().find(x=>x.lang.startsWith('es'));
  if (v) utt.voice = v;
  utt.onend = () => { hideBubble(); setTimeout(()=>applyState(S.state),400); };
  S.speaking = true;
  speechSynthesis.speak(utt);
  voiceTo = setTimeout(()=>{ hideBubble(); applyState(S.state); }, text.length*75+2000);
}
function greet() { const t=rand(GREETS[period()]); setBodyState('greeting'); speak(t,true); }
function reportStatus() {
  const msgs = [];
  if (S.temp>32) msgs.push(`temperatura de ${S.temp.toFixed(1)} grados, excesivo`);
  else if (S.temp<12) msgs.push(`apenas ${S.temp.toFixed(1)} grados, demasiado frío`);
  if (S.soil<25) msgs.push(`suelo al ${Math.round(S.soil)}%, estoy sedienta`);
  if (!msgs.length) msgs.push('condiciones óptimas');
  speak(`Estado actual: ${msgs.join('; ')}. ${S.riegos?`Regada ${S.riegos} vez hoy.`:''}`, true);
}
function toggleVoice() {
  S.voiceEnabled = !S.voiceEnabled;
  speechSynthesis.cancel();
  document.getElementById('btn-voice').textContent = S.voiceEnabled ? '○ Silenciar voz' : '● Activar voz';
}
function showBubble(t) {
  const el = document.getElementById('speech-box');
  el.textContent = t; el.classList.add('visible');
}
function hideBubble() { document.getElementById('speech-box').classList.remove('visible'); S.speaking=false; }

// ══════════ ESTADOS AVATAR ══════════
const STAMPS = { idle:'● Óptimo', hot:'▲ Calor Extremo', cold:'▼ Frío Intenso', thirsty:'◈ Sedienta', watered:'◆ Regada', greeting:'◉ Saludando', talking:'◎ Hablando' };
const STAMP_CLS = { idle:'stamp-ok', hot:'stamp-hot', cold:'stamp-cold', thirsty:'stamp-thirst', watered:'stamp-water', greeting:'stamp-greet', talking:'stamp-ok' };

function applyState(state) {
  if (S.speaking && state !== 'talking') return;
  S.state = state;
  clearInterval(blinkIv); clearInterval(particleIv); clearInterval(shakeIv); cancelAnimationFrame(animFrame);
  const pb = document.getElementById('plant-body');
  pb.style.transform = ''; pb.style.animation = '';

  const body=document.getElementById('body-circle'), mouth=document.getElementById('mouth'),
        sw=document.getElementById('sweat-drops'), cold=document.getElementById('cold-lines'),
        heart=document.getElementById('heart'), cracks=document.getElementById('cracks'),
        cl=document.getElementById('cheek-l'), cr=document.getElementById('cheek-r'),
        ll=document.getElementById('leaf-left'), lr=document.getElementById('leaf-right');

  [sw,cold,heart,cracks,cl,cr].forEach(e=>e.setAttribute('opacity','0'));
  ll.style.transform=''; lr.style.transform='';
  document.getElementById('particles').innerHTML='';

  blinkIv = setInterval(doBlink, 3200+Math.random()*2000);

  switch(state) {
    case 'idle':
      body.setAttribute('fill','#28a040');
      mouth.setAttribute('d','M70 98 Q80 107 90 98');
      startBob(); break;
    case 'hot':
      body.setAttribute('fill','#8a3020');
      mouth.setAttribute('d','M72 96 Q80 92 88 96');
      sw.setAttribute('opacity','1'); ll.style.transform='rotate(15deg)'; lr.style.transform='rotate(-12deg)';
      startHotDrips(); startBob(); break;
    case 'cold':
      body.setAttribute('fill','#2040a0');
      mouth.setAttribute('d','M74 99 Q80 95 86 99');
      cold.setAttribute('opacity','0.8'); startShiver(); break;
    case 'thirsty':
      body.setAttribute('fill','#7a7020');
      mouth.setAttribute('d','M74 100 Q80 95 86 100');
      cracks.setAttribute('opacity','1'); ll.style.transform='rotate(24deg) translateY(5px)'; lr.style.transform='rotate(-18deg) translateY(5px)';
      startBob(0.3); break;
    case 'watered':
      body.setAttribute('fill','#1a8050');
      mouth.setAttribute('d','M66 96 Q80 110 94 96');
      heart.setAttribute('opacity','1'); cl.setAttribute('opacity','0.5'); cr.setAttribute('opacity','0.5');
      startWaterParticles(); startHappyBounce(); break;
    case 'greeting':
      body.setAttribute('fill','#28a040');
      mouth.setAttribute('d','M68 96 Q80 108 92 96');
      cl.setAttribute('opacity','0.4'); cr.setAttribute('opacity','0.4');
      startWave(); break;
    case 'talking':
      body.setAttribute('fill','#28a040');
      startBob(); startTalkMouth(); break;
  }

  const stamp = document.getElementById('state-stamp');
  stamp.textContent = STAMPS[state]||'●';
  stamp.className = 'state-stamp '+(STAMP_CLS[state]||'stamp-ok');

  document.getElementById('twin-status-text').textContent = oracleStateText(state);
}
function setBodyState(s) { applyState(s); }

// ── Animaciones ──
function doBlink() {
  const l=document.getElementById('lid-l'), r=document.getElementById('lid-r');
  l.setAttribute('opacity','1'); r.setAttribute('opacity','1');
  setTimeout(()=>{ l.setAttribute('opacity','0'); r.setAttribute('opacity','0'); },110);
}
let bobA=0;
function startBob(sc=1) {
  const pb=document.getElementById('plant-body');
  function f(){ bobA+=0.024; pb.style.transform=`translateY(${Math.sin(bobA)*2*sc}px)`; animFrame=requestAnimationFrame(f); }
  f();
}
function startShiver() {
  const pb=document.getElementById('plant-body'); let t=0;
  shakeIv=setInterval(()=>{ t++; pb.style.transform=`translateX(${Math.sin(t*3)*3}px)`; },50);
}
function startHappyBounce() {
  const pb=document.getElementById('plant-body'); let t=0;
  function f(){ t+=0.08; pb.style.transform=`translateY(${-Math.abs(Math.sin(t))*9}px) scale(${1+Math.sin(t)*0.03})`; animFrame=requestAnimationFrame(f); }
  f();
}
function startWave() {
  const lr=document.getElementById('leaf-right'); let t=0;
  function f(){ t+=0.1; lr.style.transform=`rotate(${Math.sin(t)*24}deg)`; if(t<Math.PI*4) animFrame=requestAnimationFrame(f); else { lr.style.transform=''; applyState('idle'); } }
  f();
}
function startTalkMouth() {
  const m=document.getElementById('mouth'); let t=0;
  const iv=setInterval(()=>{ t++; m.setAttribute('d',Math.sin(t*0.8)>0?'M70 96 Q80 108 90 96':'M72 100 Q80 102 88 100'); if(!S.speaking) clearInterval(iv); },110);
}
function startHotDrips() {
  particleIv=setInterval(()=>spawnP(['💧','💦'],'down',44,116,60,90),900);
}
function startWaterParticles() {
  let c=0; particleIv=setInterval(()=>{ spawnP(['✨','💧','⭐','💚'],'up',50,110,70,110); c++; if(c>10)clearInterval(particleIv); },280);
}
function spawnP(emojis, dir, x1, x2, y1, y2) {
  const g=document.getElementById('particles');
  const el=document.createElementNS('http://www.w3.org/2000/svg','text');
  el.setAttribute('x', x1+Math.random()*(x2-x1));
  el.setAttribute('y', y1+Math.random()*(y2-y1));
  el.setAttribute('font-size', 9+Math.random()*5);
  el.setAttribute('text-anchor','middle');
  el.textContent = emojis[Math.floor(Math.random()*emojis.length)];
  g.appendChild(el);
  const dy=dir==='up'?-50:45, dur=1200+Math.random()*500;
  let s=null;
  function a(ts){ if(!s)s=ts; const p=(ts-s)/dur; if(p>=1){g.removeChild(el);return;} el.setAttribute('transform',`translate(${(Math.random()-.5)*20*p},${dy*p})`); el.setAttribute('opacity',1-p); requestAnimationFrame(a); }
  requestAnimationFrame(a);
}

// ══════════ RENDER SENSORES (datos reales del ESP8266) ══════════
function renderSensors(d) {
  // Temperatura
  document.getElementById('v-temp').innerHTML=d.temp.toFixed(1)+'<span class="unit">°C</span>';
  document.getElementById('b-temp').style.cssText=`width:${Math.min(100,(d.temp/50)*100)}%;background:${d.temp>34?'var(--terra2)':d.temp<12?'var(--blue3)':'var(--blue2)'}`;
  document.getElementById('a-temp').textContent = oracleAnnotTemp(d.temp);
  document.getElementById('s-temp').textContent=d.temp>34?'Temp. crítica alta':d.temp<12?'Temp. crítica baja':'Normal';

  // Humedad aire
  document.getElementById('v-hum').innerHTML=d.hum.toFixed(0)+'<span class="unit">%</span>';
  document.getElementById('b-hum').style.width=d.hum+'%';
  document.getElementById('a-hum').textContent = oracleAnnotHum(d.hum);

  // Movimiento por HC-SR04
  renderPIR(d.dist > 0 && d.dist < NEAR_CM, d.dist);

  // Suelo
  document.getElementById('v-soil').innerHTML=d.soil+'<span class="unit">%</span>';
  document.getElementById('b-soil').style.cssText=`width:${d.soil}%;background:${d.soil<25?'var(--terra)':d.soil>80?'var(--blue3)':'var(--blue2)'}`;
  document.getElementById('a-soil').textContent = oracleAnnotSoil(d.soil);
  document.getElementById('s-soil').textContent=d.soil<25?'⚠ Seco':d.soil>80?'Saturado':'Óptimo';

  // Proximidad (HC-SR04 si disponible)
  if (d.dist > 0) {
    const pct = Math.max(0, 100-(d.dist/300)*100);
    const color = d.dist<30?'#8b4020':d.dist<80?'#2a3f6f':'#6a5e4c';
    const proxVal = document.getElementById('prox-val');
    if (proxVal) { proxVal.textContent=Math.round(d.dist); proxVal.style.color=color; }
    const proxBar = document.getElementById('prox-bar');
    if (proxBar) proxBar.style.cssText=`width:${pct}%;background:${color}`;
    const proxNote = document.getElementById('prox-note');
    if (proxNote) proxNote.textContent = d.dist < NEAR_CM ? `Presencia detectada a ${Math.round(d.dist)} cm` : 'Sin movimiento en el laberinto';
    const proxIcon = document.getElementById('prox-icon');
    if (proxIcon) proxIcon.textContent = d.dist<30?'🤗':d.dist<80?'🚶':'🚪';
  }
}

function renderPIR(activo, dist) {
  const el = document.getElementById('v-pir');
  const ba = document.getElementById('b-pir');
  const an = document.getElementById('a-pir');
  const st = document.getElementById('s-pir');
  if (!el) return;
  if (activo) {
    el.textContent = '● MOVIMIENTO';
    el.style.color = 'var(--terra)';
    ba.style.width = '100%';
    an.textContent = oracleAnnotMotion(true);
    st.textContent = dist > 0 ? `${Math.round(dist)} cm detectado` : 'Presencia confirmada';
  } else {
    el.textContent = '○ Sin mov.';
    el.style.color = 'var(--ink4)';
    ba.style.width = '0%';
    an.textContent = oracleAnnotMotion(false);
    st.textContent = 'HC-SR04 · Distancia';
  }
}

function decideState(d) {
  if (S.speaking || S.state==='watered') return;
  let ns='idle';
  if(d.temp>CFG.umbralTempAlta) ns='hot';
  else if(d.temp<CFG.umbralTempBaja) ns='cold';
  else if(d.soil<CFG.umbralSueloBajo) ns='thirsty';
  if(ns!==S.state) {
    applyState(ns);
    if(S.voiceEnabled && (ns==='hot'||ns==='cold'||ns==='thirsty')) setTimeout(()=>speak(),700);
  }
}

// ══════════ RIEGO — publica comando MQTT real ══════════
function triggerWater(seg=2) {
  const safeSeg = Math.min(2, Math.max(1, Number(seg) || 1));
  S.riegos++;
  document.getElementById('stat-riegos').textContent=S.riegos;
  applyState('watered');
  speak(rand(STATE_SAY.watered),true);

  // Publicar en MQTT → ESP8266 activa la bomba
  pubMQTT('jardin/comandos/riego', { segundos: safeSeg, motivo: 'manual_dashboard' });
  mqttLog('jardin/comandos/riego',`{"segundos":${safeSeg}}`,'cmd');

  // Timeout de seguridad: si no llega confirmación del ESP8266 en seg+5s, volver a idle
  if(S.waterTimer) clearTimeout(S.waterTimer);
  S.waterTimer = setTimeout(()=>{
    S.waterTimer=null;
    applyState('idle');
  }, (safeSeg+5)*1000);
}

// ══════════ SPARKLINE ══════════
function drawSpark() {
  const c=document.getElementById('spark'); const W=c.offsetWidth||800; const H=38;
  c.width=W; c.height=H; const ctx=c.getContext('2d'); ctx.clearRect(0,0,W,H);
  const draw=(arr,color,dashed=false)=>{
    if(arr.length<2)return;
    const mn=Math.min(...arr)-1,mx=Math.max(...arr)+1,r=mx-mn||1;
    ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=1.5;
    if(dashed) ctx.setLineDash([4,3]); else ctx.setLineDash([]);
    arr.forEach((v,i)=>{ const x=(i/(arr.length-1))*W,y=H-((v-mn)/r)*(H-8)-4; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.stroke();
  };
  draw(S.historial.slice(-40).map(h=>h.temp),'#8b4020');
  draw(S.historial.slice(-40).map(h=>h.soil),'#2a3f6f',true);
  ctx.setLineDash([]);
  ctx.fillStyle='#8b4020'; ctx.font='11px Courier Prime'; ctx.fillText('── temp',4,H-3);
  ctx.fillStyle='#2a3f6f'; ctx.fillText('- - suelo',74,H-3);
}

// ══════════ PIR / PROXIMIDAD ══════════
function onPersonNear(dist) {
  const now = Date.now();
  if (now - S.lastVisitTime < VISIT_CD) return;
  S.lastVisitTime = now;

  S.visitCount++;
  document.getElementById('stat-visits').textContent = S.visitCount;

  const p = period();
  let text = 'Visita registrada.';
  let shouldSpeak = false;
  let shouldGreetAnim = false;

  if (now - S.lastGreetTime >= GREET_CD) {
    text = rand(GREETS[p]);
    shouldSpeak = true;
    shouldGreetAnim = true;
    S.lastGreetTime = now;
  } else if (
    (S.state === 'hot' || S.state === 'cold' || S.state === 'thirsty') &&
    (now - S.lastStateMsgTime >= STATE_MSG_CD)
  ) {
    text = rand(STATE_SAY[S.state]);
    shouldSpeak = true;
    S.lastStateMsgTime = now;
  }

  addVisitLog(dist,p,text);

  if (shouldGreetAnim) {
    applyState('greeting');
  }

  if (shouldSpeak) {
    setTimeout(() => speak(text,true), shouldGreetAnim ? 600 : 250);
  }

  if (dist < S.minDist) {
    S.minDist = dist;
    document.getElementById('stat-mindist').textContent = Math.round(dist);
  }
}

function addVisitLog(dist, p, text) {
  const icons={mañana:'🌅',tarde:'☀️',noche:'🌙'};
  const ts=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const idx=S.visitCount;

  ['visit-log','visit-log-twin'].forEach((id,i)=>{
    const log=document.getElementById(id);
    if(!log) return;
    const ph=log.querySelector('div[style]'); if(ph) ph.remove();
    const el=document.createElement('div'); el.className='visit-entry';
    el.innerHTML=`<span class="ve-num">[${idx}]</span><span class="ve-time">${ts}</span><span class="ve-dist">${Math.round(dist)}cm</span><span class="ve-period">${icons[p]}</span><span class="ve-text">${text}</span>`;
    log.insertBefore(el,log.firstChild);
    while(log.children.length>(i===0?10:6)) log.removeChild(log.lastChild);
  });
}

// ══════════ MQTT LOG UI ══════════
function mqttLog(topic,payload,type='pub') {
  const log=document.getElementById('mqtt-log');
  const el=document.createElement('div'); el.className='le '+type;
  const tags={pub:'tpub PUB',sub:'tsub SUB',alert:'talrt ALRT',cmd:'tcmd CMD',prox:'tprox PRX'};
  const [cls,txt]=(tags[type]||'tsub SUB').split(' ');
  const ts=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  el.innerHTML=`<span class="ltag ${cls}">${txt}</span><span class="ltime">${ts}</span><span class="ltopic">${topic}</span><span class="lpay">${typeof payload==='string'?payload:JSON.stringify(payload)}</span>`;
  log.appendChild(el); log.scrollTop=log.scrollHeight;
  while(log.children.length>80) log.removeChild(log.firstChild);
}

// ══════════ CHAT CON CLAUDE ══════════
function buildSystem() {
  const last=S.historial.slice(-1)[0]||{};
  const h=S.historial.slice(-10);
  const tMax=h.length?Math.max(...h.map(x=>x.temp)).toFixed(1):'—';
  const tMin=h.length?Math.min(...h.map(x=>x.temp)).toFixed(1):'—';

  return `Sos el Oráculo de la Biblioteca Botánica Infinita. Tu estilo es el de Jorge Luis Borges: preciso, literario, ligeramente laberíntico, con referencias sutiles a arquitectura y geometría. Respondés en español, de manera concisa pero con voz propia.

DATOS SENSORIALES EN TIEMPO REAL (ESP8266 via MQTT):
- Temperatura: ${last.temp??'—'}°C
- Humedad aire: ${last.hum??'—'}%
- Humedad suelo: ${last.soil??'—'}% (0=seco, 100=saturado)
- Movimiento HC-SR04: ${last.dist>0 && last.dist<NEAR_CM?'DETECTADO':'Sin movimiento'}
- Distancia HC-SR04: ${last.dist>0?`${Math.round(last.dist)} cm`:'N/D'}
- Estado del gemelo: ${S.state}
- Conexión MQTT: ${S.mqttConnected?'activa':'sin conexión'}

RESUMEN HISTÓRICO (${h.length} lecturas):
- Temperatura: máx ${tMax}°C, mín ${tMin}°C
- Riegos en esta sesión: ${S.riegos}
- Visitas detectadas por HC-SR04: ${S.visitCount}${S.minDist<999?`, distancia mínima: ${S.minDist}cm`:''}

UMBRALES CONFIGURADOS:
- Temp alta: ${CFG.umbralTempAlta}°C | Temp baja: ${CFG.umbralTempBaja}°C
- Riego si suelo <${CFG.umbralSueloBajo}%. No regar si suelo >60%.

Si decidís regar, terminá tu respuesta con REGAR:N (N = segundos, 1-2).
Respondé siempre en español. Sé conciso. Usá los datos reales.`;
}

function appendMsg(role,text,withRiego=false,seg=0) {
  const c=document.getElementById('chat-messages');
  const d=document.createElement('div');
  d.className=`chat-msg ${role}`; d.setAttribute('data-idx',msgIndex++);
  const roleLabel=role==='user'?'Jardinero':'Oráculo';
  const chip=withRiego?`<span class="tool-note">⚙ regar_planta(segundos=${seg}) → MQTT publicado</span>`:'';
  d.innerHTML=`<div class="msg-role ${role}">${roleLabel}</div><div class="msg-body">${chip}${text.replace(/\n/g,'<br>')}</div>`;
  c.appendChild(d); c.scrollTop=c.scrollHeight;
}

let typCount=0;
function appendTyping() {
  const id='tp'+(++typCount);
  const c=document.getElementById('chat-messages');
  const d=document.createElement('div'); d.className='chat-msg agent'; d.id=id; d.setAttribute('data-idx','…');
  d.innerHTML='<div class="msg-role agent">Oráculo</div><div class="msg-body"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
  c.appendChild(d); c.scrollTop=c.scrollHeight; return id;
}
function removeEl(id){ const e=document.getElementById(id); if(e) e.remove(); }

async function sendChat() {
  const inp=document.getElementById('chat-input');
  const txt=inp.value.trim(); if(!txt) return;
  inp.value='';
  appendMsg('user',txt);
  chatHistory.push({role:'user',content:txt});
  const btn=document.getElementById('btn-send'); btn.disabled=true;
  const tid=appendTyping();

  try {
    const res=await fetch('/api/openrouter',{
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        model: CFG.claudeModel || 'anthropic/claude-haiku-4.5',
        max_tokens:1000,
        system:buildSystem(),
        messages:chatHistory
      })
    });
    const data=await res.json();

    if (data.error || data?.choices?.[0]?.error) {
      removeEl(tid);
      appendMsg('agent',`Error de API: ${data?.error?.message || data?.choices?.[0]?.error?.message || 'Error OpenRouter'}`);
      btn.disabled=false;
      return;
    }

    const reply=data?.choices?.[0]?.message?.content||'El oráculo guarda silencio.';
    removeEl(tid);
    const m=reply.match(/REGAR:(\d+)/);
    if(m) {
      const seg = Math.min(2, Math.max(1, parseInt(m[1],10) || 1));
      appendMsg('agent',reply.replace(/REGAR:\d+/,'').trim(),true,seg);
      chatHistory.push({role:'assistant',content:reply});
      setTimeout(()=>triggerWater(seg),800);
    } else {
      appendMsg('agent',reply);
      chatHistory.push({role:'assistant',content:reply});
    }
    mqttLog('jardin/oraculo',txt.substring(0,40)+'...','sub');
  } catch(e) {
    removeEl(tid);
    appendMsg('agent',`Error de red: ${e.message}. Verificá conexión y CORS.`);
  }
  btn.disabled=false;
}

function sendQuick(txt){ document.getElementById('chat-input').value=txt; sendChat(); }

function toggleAccord(id) {
  const root = document.getElementById(id);
  if (!root) return;
  root.classList.toggle('open');
}

function simProx(value) {
  const dist = Number(value);
  const sv = document.getElementById('prox-sv');
  const slider = document.getElementById('prox-slider');
  if (sv) sv.textContent = `${dist} cm`;
  if (slider && Number(slider.value) !== dist) slider.value = String(dist);

  const payload = { distancia_cm: dist, cerca: dist < NEAR_CM, source: 'simulador_ui' };
  const r = {
    temp: S.temp,
    hum: S.hum,
    soil: S.soil,
    dist,
    ts: new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
  };

  renderSensors(r);
  renderPIR(payload.cerca, dist);
  if (payload.cerca) onPersonNear(dist);
  mqttLog('jardin/proximidad', payload, 'prox');
}

function simProxInstant(dist) {
  simProx(Number(dist));
}

// ══════════ INIT ══════════
setTimeout(()=>speechSynthesis.getVoices(),400);
applyState('idle');

// Conectar MQTT
initMQTT();

// Mensaje inicial en chat
appendMsg('agent','El archivo botánico está activo. Aguardando datos del ESP8266 via MQTT. Podés consultarme sobre el estado de la planta o pedirme que la riegue.');

// Saludo inicial
setTimeout(()=>{ showBubble(rand(GREETS[period()])); setTimeout(hideBubble,4000); },1600);

// Clock en footer
setInterval(()=>{ document.getElementById('footer-time').textContent=new Date().toLocaleTimeString('es-AR'); },1000);
