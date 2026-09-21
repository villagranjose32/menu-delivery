# Menú delivery

App de menús y pedidos por WhatsApp con servidor Node.js. Requiere Node 20 o superior; no necesita instalar dependencias.

## Iniciar

Copiá las variables de entorno y reemplazá las credenciales de ejemplo:

```bash
cp .env.example .env
```

Node no carga `.env` automáticamente, por lo que para desarrollo podés ejecutar:

```bash
ADMIN_EMAIL=admin@ejemplo.com ADMIN_PASSWORD='una-clave-larga-y-privada' npm start
```

Abrí `http://localhost:3000`. El administrador se crea al primer inicio con esas variables. Cada local se registra desde la app y queda pendiente hasta que el administrador apruebe su cuenta. Al aprobarla, puede editar su menú y compartir un enlace permanente `/?menu=nombre-del-local`.

Los datos se guardan en `data/db.json` y las imágenes en `data/uploads/`. Hacé copias de seguridad de toda la carpeta `data/`. Para usar la app desde Internet, servila detrás de HTTPS y configurá un volumen persistente para `data/`. El envío de pedidos continúa por WhatsApp; la app no almacena pedidos.

Para cambiar la contraseña del administrador, reiniciá el servidor con un nuevo valor de `ADMIN_PASSWORD`. Las sesiones anteriores del administrador se cerrarán.

## Pruebas

```bash
npm test
```

## Docker

```bash
docker build -t menu-delivery .
docker run --rm -p 3000:3000 \
  -e ADMIN_EMAIL=admin@ejemplo.com \
  -e ADMIN_PASSWORD='una-clave-larga-y-privada' \
  -v menu-delivery-data:/app/data \
  menu-delivery
```

En producción configurá `ADMIN_EMAIL` y `ADMIN_PASSWORD` como secretos del servicio. Montá un volumen persistente en `/app/data`; allí se almacenan cuentas, menús, sesiones e imágenes.

## Publicar en GitHub

El archivo `.env` y la carpeta `data/` están excluidos del repositorio. Para subir una rama ya preparada:

```bash
git push -u origin main
```
