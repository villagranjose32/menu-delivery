'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }
test('registro, aprobación, menú público e imagen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-test-'));
  const port = await freePort();
  const processServer = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_EMAIL: 'admin@test.com', ADMIN_PASSWORD: 'admin-secret-123' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  async function request(route, method = 'GET', data, cookie) { const r = await fetch(base + route, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: data && JSON.stringify(data) }); return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; }
  try {
    for (let i = 0; i < 30; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
    let r = await request('/api/register', 'POST', { email: 'local@test.com', businessName: 'La Esquina', password: 'owner-secret-123' }); assert.equal(r.status, 201);
    r = await request('/api/login', 'POST', { email: 'local@test.com', password: 'owner-secret-123' }); assert.equal(r.status, 200); const owner = r.cookie;
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
    const imageResponse = await fetch(base + img); assert.equal(imageResponse.status, 200);
    assert.equal((await request('/api/admin/accounts', 'GET', undefined, owner)).status, 403);
  } finally { processServer.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
