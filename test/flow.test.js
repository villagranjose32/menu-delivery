'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');

async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }
test('registro, aprobación, menú público e imagen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-test-'));
  const port = await freePort();
  const geocoderPort = await freePort();
  const geocoder = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if(req.url.startsWith('/route/')) res.end(JSON.stringify({code:'Ok',routes:[{distance:4200,duration:720}]})); else res.end(JSON.stringify([{ lat: '-27.7951', lon: '-64.2615', display_name: 'Av. Belgrano 1240, Santiago del Estero' }])); });
  await new Promise(resolve => geocoder.listen(geocoderPort, '127.0.0.1', resolve));
  const processServer = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir, PORT: String(port), GEOCODER_URL: `http://127.0.0.1:${geocoderPort}`, ROUTING_URL: `http://127.0.0.1:${geocoderPort}`, ADMIN_EMAIL: 'admin@test.com', ADMIN_PASSWORD: 'admin-secret-123' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  async function request(route, method = 'GET', data, cookie, headers = {}) { const r = await fetch(base + route, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: data && JSON.stringify(data) }); return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; }
  try {
    for (let i = 0; i < 30; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
    let location = await request('/api/geocode?q=Av.%20Belgrano%201240%2C%20Santiago'); assert.equal(location.status, 200); assert.equal(location.data.lat, -27.7951);
    let route = await request('/api/route-distance?from=-27.7951,-64.2615&to=-27.81,-64.28'); assert.equal(route.status, 200); assert.equal(route.data.distanceKm, 4.2);
    let r = await request('/api/register', 'POST', { email: 'local@test.com', businessName: 'La Esquina', password: 'owner-secret-123' }); assert.equal(r.status, 201);
    assert.equal((await request('/api/register', 'POST', { email: 'local@test.com', businessName: 'La Esquina Norte', password: 'other-secret-123' })).status, 201);
    assert.equal((await request('/api/register', 'POST', { email: 'otro@test.com', businessName: 'La Esquina', password: 'other-secret-123' })).status, 409);
    assert.equal((await request('/api/login', 'POST', { email: 'local@test.com', password: 'owner-secret-123' })).status, 401);
    r = await request('/api/login', 'POST', { email: 'local@test.com', businessName: 'La Esquina', password: 'owner-secret-123' }); assert.equal(r.status, 200); const owner = r.cookie;
    assert.equal((await request('/api/my-menu', 'GET', undefined, owner)).status, 403);
    assert.equal((await request('/api/menu?slug=la-esquina')).status, 404);
    r = await request('/api/login', 'POST', { email: 'admin@test.com', password: 'admin-secret-123' }); const admin = r.cookie;
    r = await request('/api/admin/accounts', 'GET', undefined, admin); assert.equal(r.data.users[0].status, 'pending');
    const id = r.data.users[0].id;
    assert.equal((await request(`/api/admin/accounts/${id}/approve`, 'POST', {}, admin)).status, 200);
    const image = 'data:image/png;base64,' + Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');
    r = await request('/api/upload', 'POST', { image }, owner); assert.equal(r.status, 201);
    const img = r.data.url;
    const menu = { nombre: 'La Esquina', tel: '5491112345678', coord: '-27.7951, -64.2615', costoEnvio: 1000, costoEnvioKm: 500, cats: [{ id: 'cat1', nombre: 'Comidas', img: '', productos: [{ id: 'prod1', nombre: 'Pizza', precio: 1200, detalle: '', hay: true, img }] }] };
    assert.equal((await request('/api/my-menu', 'PUT', menu, owner)).status, 200);
    r = await request('/api/menu?slug=la-esquina'); assert.equal(r.data.menu.cats[0].productos[0].img, img); assert.equal(r.data.menu.costoEnvioKm, 500);
    r = await request('/api/couriers', 'POST', { name: 'Juan' }, owner); assert.equal(r.status, 201); const courierToken = r.data.token; const courierId = r.data.courier.id;
    r = await request('/api/courier-login', 'POST', { slug: 'la-esquina', token: courierToken }); assert.equal(r.status, 200); const courierSession = r.data.session;
    assert.equal((await request('/api/courier-location', 'POST', { lat: -27.8, lng: -64.27 }, undefined, { 'X-Courier-Session': courierSession })).status, 200);
    r = await request('/api/deliveries', 'POST', { courierId, address: 'Av. Roca 100', customer: 'María', coord: { lat: -27.81, lng: -64.28 } }, owner); assert.equal(r.status, 201); const delivery = r.data.delivery;
    r = await request('/api/tracking?id=' + delivery.trackingId); assert.equal(r.data.delivery.status, 'pending'); assert.equal(r.data.courier.lastLocation, null);
    assert.equal((await request(`/api/courier-deliveries/${delivery.id}/start`, 'POST', {}, undefined, { 'X-Courier-Session': courierSession })).status, 200);
    r = await request('/api/tracking?id=' + delivery.trackingId); assert.equal(r.data.delivery.status, 'active'); assert.equal(r.data.courier.lastLocation.lat, -27.8);
    assert.equal((await request(`/api/courier-deliveries/${delivery.id}/finish`, 'POST', {}, undefined, { 'X-Courier-Session': courierSession })).status, 200);
    r = await request('/api/tracking?id=' + delivery.trackingId); assert.equal(r.data.delivery.status, 'finished'); assert.equal(r.data.courier.lastLocation.lat, -27.8);
    const imageResponse = await fetch(base + img); assert.equal(imageResponse.status, 200);
    assert.equal((await request('/api/admin/accounts', 'GET', undefined, owner)).status, 403);
  } finally { processServer.kill(); await new Promise(resolve => geocoder.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
