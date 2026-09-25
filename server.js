'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB = path.join(DATA, 'db.json');
const UPLOADS = path.join(DATA, 'uploads');
const PORT = Number(process.env.PORT || 3000);
const COOKIE = 'menu_session';
const loginAttempts = new Map();
fs.mkdirSync(UPLOADS, { recursive: true });
let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { users: [], menus: {}, sessions: {} };
db.users ||= []; db.menus ||= {}; db.sessions ||= {}; db.geocode ||= {}; db.routes ||= {}; db.couriers ||= []; db.deliveries ||= {}; db.courierSessions ||= {};
let lastGeocodeAt = 0;
let lastRouteAt = 0;
function persist() { const tmp = DB + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB); }
function json(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); }
function error(res, status, message) { json(res, status, { error: message }); }
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function checkPassword(password, saved) { if (!saved) return false; const [salt, hash] = saved.split(':'); const candidate = passwordHash(password, salt).split(':')[1]; return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex')); }
function publicUser(user) { return { id: user.id, email: user.email, role: user.role, status: user.status, slug: user.slug, businessName: user.businessName }; }
function slugify(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'local'; }
function sessionUser(req) { const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1); const session = token && db.sessions[token]; if (!session || session.expires < Date.now()) return null; return db.users.find(u => u.id === session.userId) || null; }
function sessionCourier(req) { const token = req.headers['x-courier-session']; const session = token && db.courierSessions[token]; if (!session || session.expires < Date.now()) return null; return db.couriers.find(c => c.id === session.courierId) || null; }
function publicCourier(c) { return { id:c.id, name:c.name, status:c.status || 'offline', lastLocation:c.lastLocation || null, updatedAt:c.updatedAt || null }; }
function publicDelivery(d) { return { id:d.id, courierId:d.courierId, address:d.address, customer:d.customer, coord:d.coord, status:d.status, trackingId:d.trackingId, createdAt:d.createdAt, startedAt:d.startedAt || null, finishedAt:d.finishedAt || null }; }
function needUser(req, res, role) { const user = sessionUser(req); if (!user) { error(res, 401, 'Iniciá sesión.'); return null; } if (role && user.role !== role) { error(res, 403, 'No tenés permiso.'); return null; } if (user.role === 'owner' && user.status !== 'approved' && role === 'owner') { error(res, 403, 'Tu cuenta todavía no fue aprobada.'); return null; } return user; }
async function body(req, limit = 1024 * 1024) { let size = 0, chunks = []; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Archivo demasiado grande.'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
function safeText(v, max = 300) { return String(v ?? '').trim().slice(0, max); }
function normalizeMenu(raw, ownerName) { if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cats) || raw.cats.length > 80) throw new Error('Menú inválido.'); return { nombre: safeText(ownerName, 100), tel: (t => { if (t && !/^[1-9]\d{7,14}$/.test(t)) throw new Error('Número de WhatsApp inválido. Usá código de país y entre 8 y 15 dígitos.'); return t; })(safeText(raw.tel, 30).replace(/\D/g, '')), lema: safeText(raw.lema, 300), dir: safeText(raw.dir, 200), coord: safeText(raw.coord, 80), geoPais: safeText(raw.geoPais, 2).toLowerCase(), geoProvincia: safeText(raw.geoProvincia, 100), moneda: safeText(raw.moneda, 8) || '$', costoEnvio: Math.max(0, Number(raw.costoEnvio) || 0), costoEnvioKm: Math.max(0, Number(raw.costoEnvioKm) || 0), haceEnvio: !!raw.haceEnvio, haceRetiro: !!raw.haceRetiro, pagos: (Array.isArray(raw.pagos) ? raw.pagos : []).slice(0, 15).map(p => safeText(p, 60)), cats: raw.cats.map(c => ({ id: safeText(c.id, 40), nombre: safeText(c.nombre, 100), img: imagePath(c.img), productos: (Array.isArray(c.productos) ? c.productos : []).slice(0, 200).map(p => ({ id: safeText(p.id, 40), nombre: safeText(p.nombre, 100), precio: Math.max(0, Number(p.precio) || 0), detalle: safeText(p.detalle, 500), hay: p.hay !== false, img: imagePath(p.img) })) })) }; }
function imagePath(v) { return typeof v === 'string' && /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(v) ? v : ''; }
function sameOrigin(req) { const origin = req.headers.origin; if (!origin) return true; const host = req.headers.host; return new URL(origin).host === host; }
function defaultMenu(name) { return { nombre: name, tel: '', lema: '', dir: '', coord: '', geoPais: '', geoProvincia: '', moneda: '$', costoEnvio: 0, costoEnvioKm: 0, haceEnvio: true, haceRetiro: true, pagos: ['Efectivo', 'Transferencia'], cats: [] }; }
function serveFile(res, file, type, cache = 'no-store') { fs.readFile(file, (err, contents) => { if (err) return error(res, 404, 'No encontrado.'); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' }); res.end(contents); }); }
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method;
  if (method === 'GET' && url.pathname === '/') return serveFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
  if (method === 'GET' && /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(url.pathname)) return serveFile(res, path.join(DATA, url.pathname), `image/${url.pathname.split('.').pop() === 'jpg' ? 'jpeg' : url.pathname.split('.').pop()}`, 'public, max-age=31536000, immutable');
  if (!url.pathname.startsWith('/api/')) return error(res, 404, 'No encontrado.');
  if (!['GET', 'POST', 'PUT'].includes(method)) return error(res, 405, 'Método no permitido.');
  if (method !== 'GET' && !sameOrigin(req)) return error(res, 403, 'Origen no permitido.');
  if (method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: sessionUser(req) && publicUser(sessionUser(req)) });
  if (method === 'GET' && url.pathname === '/api/geocode') {
    const query = safeText(url.searchParams.get('q'), 250), context = safeText(url.searchParams.get('context'), 200), country = safeText(url.searchParams.get('country'), 2).toLowerCase();
    const nearParts=String(url.searchParams.get('near')||'').split(',').map(Number), near=nearParts.length===2&&isFinite(nearParts[0])&&isFinite(nearParts[1])?{lat:nearParts[0],lng:nearParts[1]}:null;
    if (query.length < 5) return error(res, 400, 'Escribí calle, número y localidad.');
    const regionContext=context.includes(',')?context.split(',').slice(1).join(',').trim():'';
    const contextualQuery=regionContext&&!query.toLowerCase().includes(regionContext.toLowerCase())?`${query}, ${regionContext}`:query;
    const key = crypto.createHash('sha256').update(`${contextualQuery.toLowerCase()}|${country}|${near?`${near.lat.toFixed(2)},${near.lng.toFixed(2)}`:''}`).digest('hex');
    if (db.geocode[key]) return json(res, 200, db.geocode[key]);
    if (Date.now() - lastGeocodeAt < 1100) return error(res, 429, 'Esperá un segundo antes de buscar otra dirección.');
    lastGeocodeAt = Date.now();
    const base = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const search = new URL('/search', base); search.searchParams.set('q', contextualQuery); search.searchParams.set('format', 'jsonv2'); search.searchParams.set('limit', '1'); search.searchParams.set('accept-language', 'es'); search.searchParams.set('addressdetails','1');
      if(/^[a-z]{2}$/.test(country))search.searchParams.set('countrycodes',country);
      if(near){const latRadius=25/111.32,lngRadius=25/(111.32*Math.max(0.2,Math.cos(near.lat*Math.PI/180)));search.searchParams.set('viewbox',[near.lng-lngRadius,near.lat+latRadius,near.lng+lngRadius,near.lat-latRadius].join(','));search.searchParams.set('bounded','1');}
      const upstream = await fetch(search, { headers: { 'User-Agent': `menu-delivery/1.0 (${process.env.ADMIN_EMAIL || 'contacto no configurado'})`, Accept: 'application/json' }, signal: controller.signal });
      if (!upstream.ok) throw new Error('El servicio de mapas no respondió.');
      const results = await upstream.json(); if (!results[0]) return error(res, 404, 'No encontramos esa dirección. Agregá ciudad y provincia.');
      const result = { lat: Number(results[0].lat), lng: Number(results[0].lon), displayName: safeText(results[0].display_name, 300), countryCode:safeText(results[0].address?.country_code,2).toLowerCase(), state:safeText(results[0].address?.state||results[0].address?.province,100) };
      if(near){const rad=Math.PI/180,dLat=(result.lat-near.lat)*rad,dLng=(result.lng-near.lng)*rad,a=Math.sin(dLat/2)**2+Math.cos(near.lat*rad)*Math.cos(result.lat*rad)*Math.sin(dLng/2)**2,distance=6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));if(distance>25)return error(res,404,'La dirección está fuera del radio de entrega de 25 km.');}
      db.geocode[key] = result; persist(); return json(res, 200, result);
    } catch (e) { return error(res, 502, e.name === 'AbortError' ? 'La búsqueda tardó demasiado. Intentá nuevamente.' : e.message); }
    finally { clearTimeout(timer); }
  }
  if (method === 'GET' && url.pathname === '/api/address-suggestions') {
    if(!process.env.GEOAPIFY_API_KEY)return error(res,503,'Las sugerencias de direcciones no están configuradas.');
    const query=safeText(url.searchParams.get('q'),200),parts=String(url.searchParams.get('near')||'').split(',').map(Number),near=parts.length===2&&isFinite(parts[0])&&isFinite(parts[1])?{lat:parts[0],lng:parts[1]}:null;
    if(query.length<3||!near)return json(res,200,{suggestions:[]});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
    try{const endpoint=new URL('/v1/geocode/autocomplete',process.env.GEOAPIFY_URL||'https://api.geoapify.com');endpoint.searchParams.set('text',query);endpoint.searchParams.set('format','json');endpoint.searchParams.set('limit','5');endpoint.searchParams.set('lang','es');endpoint.searchParams.set('filter',`circle:${near.lng},${near.lat},25000`);endpoint.searchParams.set('bias',`proximity:${near.lng},${near.lat}`);endpoint.searchParams.set('apiKey',process.env.GEOAPIFY_API_KEY);const upstream=await fetch(endpoint,{signal:controller.signal});if(!upstream.ok)throw new Error('El servicio de sugerencias no respondió.');const data=await upstream.json();const suggestions=(data.results||[]).map(x=>({label:safeText(x.formatted,250),lat:Number(x.lat),lng:Number(x.lon)})).filter(x=>x.label&&isFinite(x.lat)&&isFinite(x.lng));return json(res,200,{suggestions});}catch(e){return error(res,502,e.name==='AbortError'?'La búsqueda tardó demasiado.':e.message);}finally{clearTimeout(timer);}
  }
  if (method === 'GET' && url.pathname === '/api/reverse-geocode') {
    const lat=Number(url.searchParams.get('lat')),lng=Number(url.searchParams.get('lng'));if(!isFinite(lat)||!isFinite(lng)||lat < -90||lat > 90||lng < -180||lng > 180)return error(res,400,'Ubicación inválida.');
    const key=`reverse:${lat.toFixed(5)},${lng.toFixed(5)}`;if(db.geocode[key])return json(res,200,db.geocode[key]);if(Date.now()-lastGeocodeAt<1100)return error(res,429,'Esperá un segundo antes de buscar otra ubicación.');lastGeocodeAt=Date.now();
    const base=process.env.GEOCODER_URL||'https://nominatim.openstreetmap.org',controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{const endpoint=new URL('/reverse',base);endpoint.searchParams.set('lat',lat);endpoint.searchParams.set('lon',lng);endpoint.searchParams.set('format','jsonv2');endpoint.searchParams.set('zoom','18');endpoint.searchParams.set('addressdetails','1');endpoint.searchParams.set('accept-language','es');const upstream=await fetch(endpoint,{headers:{'User-Agent':`menu-delivery/1.0 (${process.env.ADMIN_EMAIL||'contacto no configurado'})`,Accept:'application/json'},signal:controller.signal});if(!upstream.ok)throw new Error('El servicio de mapas no respondió.');const data=await upstream.json();if(!data.display_name)return error(res,404,'No encontramos una dirección para ese punto.');const result={displayName:safeText(data.display_name,300),lat:Number(data.lat),lng:Number(data.lon)};db.geocode[key]=result;persist();return json(res,200,result);}catch(e){return error(res,502,e.name==='AbortError'?'La búsqueda tardó demasiado.':e.message);}finally{clearTimeout(timer);}
  }
  if (method === 'GET' && url.pathname === '/api/route-distance') {
    const parse = value => { const p=String(value||'').split(',').map(Number); return p.length===2&&isFinite(p[0])&&isFinite(p[1])&&p[0]>=-90&&p[0]<=90&&p[1]>=-180&&p[1]<=180?{lat:p[0],lng:p[1]}:null; };
    const from=parse(url.searchParams.get('from')),to=parse(url.searchParams.get('to'));if(!from||!to)return error(res,400,'Ubicaciones inválidas.');
    const key=crypto.createHash('sha256').update(`${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}`).digest('hex');if(db.routes[key])return json(res,200,db.routes[key]);
    if(Date.now()-lastRouteAt<500)return error(res,429,'Esperá un momento antes de calcular otra ruta.');lastRouteAt=Date.now();
    const base=process.env.ROUTING_URL||'https://router.project-osrm.org';const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{const route=new URL(`/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`,base);route.searchParams.set('overview','false');route.searchParams.set('alternatives','false');const upstream=await fetch(route,{headers:{'User-Agent':`menu-delivery/1.0 (${process.env.ADMIN_EMAIL||'contacto no configurado'})`,Accept:'application/json'},signal:controller.signal});if(!upstream.ok)throw new Error('El servicio de rutas no respondió.');const data=await upstream.json();if(data.code!=='Ok'||!data.routes?.[0])return error(res,404,'No encontramos un recorrido por calles entre esos puntos.');const result={distanceKm:data.routes[0].distance/1000,durationMinutes:Math.ceil(data.routes[0].duration/60)};db.routes[key]=result;persist();return json(res,200,result);}catch(e){return error(res,502,e.name==='AbortError'?'El cálculo de ruta tardó demasiado.':e.message);}finally{clearTimeout(timer);}
  }
  if (method === 'POST' && url.pathname === '/api/register') {
    const data = await body(req); const email = safeText(data.email, 254).toLowerCase(), name = safeText(data.businessName, 100), password = String(data.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || password.length < 10) return error(res, 400, 'Ingresá nombre, email válido y contraseña de al menos 10 caracteres.');
    const slug = slugify(name);
    if (db.users.some(u => u.role === 'owner' && u.slug === slug)) return error(res, 409, 'Ese nombre o alias de local ya está registrado. Elegí otro.');
    const user = { id: crypto.randomUUID(), email, businessName: name, slug, role: 'owner', status: 'pending', passwordHash: passwordHash(password), createdAt: Date.now() };
    db.users.push(user); db.menus[user.id] = defaultMenu(name); persist(); return json(res, 201, { message: 'Cuenta creada. Esperá la aprobación del administrador.' });
  }
  if (method === 'POST' && url.pathname === '/api/login') {
    const data = await body(req); const email = safeText(data.email, 254).toLowerCase(); const requestedSlug = data.businessName ? slugify(safeText(data.businessName, 100)) : ''; const key = `${req.socket.remoteAddress}:${email}:${requestedSlug}`;
    const attempts = loginAttempts.get(key) || { count: 0, until: 0 };
    if (attempts.count >= 10 && attempts.until > Date.now()) return error(res, 429, 'Demasiados intentos. Probá de nuevo en 15 minutos.');
    const user = requestedSlug ? db.users.find(u => u.role === 'owner' && u.email === email && u.slug === requestedSlug) : db.users.find(u => u.role === 'admin' && u.email === email);
    if (!user || !checkPassword(String(data.password || ''), user.passwordHash)) { loginAttempts.set(key, { count: attempts.count + 1, until: Date.now() + 15 * 60000 }); return error(res, 401, requestedSlug ? 'Local, email o contraseña incorrectos.' : 'Para ingresar a un local, escribí también su nombre o alias.'); }
    loginAttempts.delete(key);
    const token = crypto.randomBytes(32).toString('hex'); db.sessions[token] = { userId: user.id, expires: Date.now() + 7 * 86400000 }; persist();
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${req.socket.encrypted ? '; Secure' : ''}` });
  }
  if (method === 'POST' && url.pathname === '/api/logout') { const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1); if (token) delete db.sessions[token]; persist(); return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); }
  if (method === 'GET' && url.pathname === '/api/couriers') { const user = needUser(req, res, 'owner'); if (!user) return; return json(res, 200, { couriers: db.couriers.filter(c => c.ownerId === user.id).map(publicCourier), deliveries: Object.values(db.deliveries).filter(d => d.ownerId === user.id).map(publicDelivery) }); }
  if (method === 'POST' && url.pathname === '/api/couriers') {
    const user = needUser(req, res, 'owner'); if (!user) return; const data = await body(req); const name = safeText(data.name, 80); let token = safeText(data.token, 64);
    if (name.length < 2) return error(res, 400, 'Ingresá el nombre del cadete.');
    if (token && token.length < 6) return error(res, 400, 'El token debe tener al menos 6 caracteres.');
    if (!token) { const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; do { token=Array.from(crypto.randomBytes(8), b => chars[b % chars.length]).join(''); } while (db.couriers.some(c => checkPassword(token,c.tokenHash))); }
    if (db.couriers.some(c => checkPassword(token,c.tokenHash))) return error(res, 409, 'Ese token ya está en uso. Elegí otro.');
    const courier={ id:crypto.randomUUID(), ownerId:user.id, name, tokenHash:passwordHash(token), status:'offline', createdAt:Date.now() }; db.couriers.push(courier); persist(); return json(res,201,{courier:publicCourier(courier),token});
  }
  if (method === 'POST' && url.pathname === '/api/courier-login') {
    const data=await body(req); const slug=safeText(data.slug,60); const token=safeText(data.token,64); const owner=db.users.find(u => u.role==='owner' && u.slug===slug && u.status==='approved');
    if(!owner) return error(res,404,'Local no encontrado.'); const courier=db.couriers.find(c => c.ownerId===owner.id && checkPassword(token,c.tokenHash)); if(!courier) return error(res,401,'Token incorrecto.');
    const auth=crypto.randomBytes(32).toString('hex'); db.courierSessions[auth]={courierId:courier.id,expires:Date.now()+12*3600000}; courier.status='online'; courier.updatedAt=Date.now(); persist();
    return json(res,200,{session:auth,courier:publicCourier(courier),local:owner.businessName,deliveries:Object.values(db.deliveries).filter(d => d.courierId===courier.id && d.status!=='finished').map(publicDelivery)});
  }
  if (method === 'GET' && url.pathname === '/api/courier-deliveries') { const courier=sessionCourier(req); if(!courier) return error(res,401,'Sesión de cadete vencida.'); return json(res,200,{courier:publicCourier(courier),deliveries:Object.values(db.deliveries).filter(d => d.courierId===courier.id && d.status!=='finished').map(publicDelivery)}); }
  if (method === 'POST' && url.pathname === '/api/courier-location') { const courier=sessionCourier(req); if(!courier) return error(res,401,'Sesión de cadete vencida.'); const data=await body(req); const lat=Number(data.lat),lng=Number(data.lng); if(!isFinite(lat)||!isFinite(lng)||lat < -90||lat > 90||lng < -180||lng > 180) return error(res,400,'Ubicación inválida.'); courier.lastLocation={lat,lng};courier.status='online';courier.updatedAt=Date.now();persist();return json(res,200,{ok:true}); }
  const courierAction=/^\/api\/courier-deliveries\/([a-f0-9-]+)\/(start|finish)$/.exec(url.pathname);
  if(method==='POST'&&courierAction){const courier=sessionCourier(req);if(!courier)return error(res,401,'Sesión de cadete vencida.');const delivery=db.deliveries[courierAction[1]];if(!delivery||delivery.courierId!==courier.id)return error(res,404,'Entrega no encontrada.');if(courierAction[2]==='start'){if(delivery.status!=='pending')return error(res,409,'La entrega ya fue iniciada.');if(Object.values(db.deliveries).some(d => d.courierId===courier.id&&d.status==='active'))return error(res,409,'Finalizá el recorrido activo antes de iniciar otro.');delivery.status='active';delivery.startedAt=Date.now();}else{if(delivery.status!=='active')return error(res,409,'Primero iniciá el recorrido.');delivery.status='finished';delivery.finishedAt=Date.now();delivery.finalLocation=courier.lastLocation||null;}persist();return json(res,200,{delivery:publicDelivery(delivery)});}
  if (method === 'POST' && url.pathname === '/api/deliveries') { const user=needUser(req,res,'owner');if(!user)return;const data=await body(req);const courier=db.couriers.find(c => c.id===data.courierId&&c.ownerId===user.id);const address=safeText(data.address,250),customer=safeText(data.customer,120),lat=Number(data.coord?.lat),lng=Number(data.coord?.lng);if(!courier)return error(res,404,'Cadete no encontrado.');if(address.length<5||!isFinite(lat)||!isFinite(lng))return error(res,400,'Buscá una dirección válida.');const id=crypto.randomUUID();const delivery={id,ownerId:user.id,courierId:courier.id,address,customer,coord:{lat,lng},status:'pending',trackingId:crypto.randomBytes(16).toString('hex'),createdAt:Date.now()};db.deliveries[id]=delivery;persist();return json(res,201,{delivery:publicDelivery(delivery)}); }
  if (method === 'GET' && url.pathname === '/api/tracking') { const trackingId=safeText(url.searchParams.get('id'),64);const delivery=Object.values(db.deliveries).find(d => d.trackingId===trackingId);if(!delivery)return error(res,404,'Seguimiento no encontrado.');const courier=db.couriers.find(c => c.id===delivery.courierId),owner=db.users.find(u => u.id===delivery.ownerId);let visibleCourier=courier&&publicCourier(courier);if(visibleCourier&&delivery.status==='pending')visibleCourier={...visibleCourier,lastLocation:null,updatedAt:null};if(visibleCourier&&delivery.status==='finished')visibleCourier={...visibleCourier,lastLocation:delivery.finalLocation||null,updatedAt:delivery.finishedAt};return json(res,200,{delivery:publicDelivery(delivery),courier:visibleCourier,local:owner?.businessName||''}); }
  if (method === 'GET' && url.pathname === '/api/menu') { const slug = url.searchParams.get('slug'); const owner = db.users.find(u => u.slug === slug && u.role === 'owner' && u.status === 'approved'); if (!owner) return error(res, 404, 'Menú no disponible.'); return json(res, 200, { menu: db.menus[owner.id] || defaultMenu(owner.businessName) }); }
  if (method === 'GET' && url.pathname === '/api/my-menu') { const user = needUser(req, res, 'owner'); if (!user) return; return json(res, 200, { menu: db.menus[user.id] || defaultMenu(user.businessName) }); }
  if (method === 'PUT' && url.pathname === '/api/my-menu') { const user = needUser(req, res, 'owner'); if (!user) return; try { db.menus[user.id] = normalizeMenu(await body(req, 2 * 1024 * 1024), user.businessName); persist(); return json(res, 200, { menu: db.menus[user.id] }); } catch (e) { return error(res, 400, e.message); } }
  if (method === 'POST' && url.pathname === '/api/upload') { const user = needUser(req, res, 'owner'); if (!user) return; const data = await body(req, 3 * 1024 * 1024); const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data.image || ''); if (!match) return error(res, 400, 'Imagen inválida.'); const bytes = Buffer.from(match[2], 'base64'); if (bytes.length > 2 * 1024 * 1024) return error(res, 413, 'Imagen demasiado grande.');
    const valid = match[1] === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) : match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) return error(res, 400, 'Imagen inválida.'); const ext = match[1] === 'jpeg' ? 'jpg' : match[1]; const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`; fs.writeFileSync(path.join(UPLOADS, name), bytes); return json(res, 201, { url: `/uploads/${name}` }); }
  if (method === 'GET' && url.pathname === '/api/admin/accounts') { if (!needUser(req, res, 'admin')) return; return json(res, 200, { users: db.users.filter(u => u.role === 'owner').map(publicUser) }); }
  const approval = /^\/api\/admin\/accounts\/([a-f0-9-]+)\/(approve|reject)$/.exec(url.pathname);
  if (method === 'POST' && approval) { if (!needUser(req, res, 'admin')) return; const owner = db.users.find(u => u.id === approval[1] && u.role === 'owner'); if (!owner) return error(res, 404, 'Cuenta no encontrada.'); owner.status = approval[2] === 'approve' ? 'approved' : 'rejected'; persist(); return json(res, 200, { user: publicUser(owner) }); }
  return error(res, 404, 'No encontrado.');
}
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  if (process.env.ADMIN_PASSWORD.length < 10) throw new Error('ADMIN_PASSWORD debe tener al menos 10 caracteres.');
  const admin = db.users.find(u => u.email === email && u.role === 'admin');
  if (!admin) { db.users.push({ id: crypto.randomUUID(), email, businessName: 'Administración', role: 'admin', status: 'approved', passwordHash: passwordHash(process.env.ADMIN_PASSWORD) }); persist(); }
  else if (!checkPassword(process.env.ADMIN_PASSWORD, admin.passwordHash)) { admin.passwordHash = passwordHash(process.env.ADMIN_PASSWORD); db.sessions = Object.fromEntries(Object.entries(db.sessions).filter(([, session]) => session.userId !== admin.id)); persist(); }
}
const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(e => { console.error(e); error(res, e.message === 'Archivo demasiado grande.' ? 413 : 400, e.message || 'Solicitud inválida.'); }); });
if (require.main === module) server.listen(PORT, () => console.log(`Menú disponible en http://localhost:${PORT}`));
module.exports = { server };
