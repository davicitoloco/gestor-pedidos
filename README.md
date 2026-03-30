# Gestor de Pedidos

Aplicación web para gestión de pedidos, clientes y productos. Multi-usuario con roles (admin / vendedor).

## Requisitos

- Node.js v22 o superior (usa el módulo `node:sqlite` integrado)

## Instalación

```bash
git clone https://github.com/davicitoloco/gestor-pedidos.git
cd gestor-pedidos
npm install
```

## Configuración

Creá un archivo `.env` en la raíz con:

```
SESSION_SECRET=una-clave-secreta-larga
```

Si no se define, usa un valor por defecto (no recomendado en producción).

## Correr en desarrollo

```bash
npm run dev
```

## Correr en producción

```bash
npm start
```

La app queda disponible en `http://localhost:3000`.

## Usuario inicial

Al arrancar por primera vez se crea automáticamente:

- **Usuario:** `admin`
- **Contraseña:** `admin123`

> Cambiá la contraseña desde la sección Usuarios antes de dar acceso a otros.

## Estructura

```
├── server.js          # Entrada principal, Express
├── db.js              # Base de datos SQLite + migraciones
├── routes/
│   ├── auth.js        # Login / logout
│   ├── orders.js      # Pedidos
│   ├── products.js    # Catálogo de productos
│   ├── customers.js   # Clientes
│   ├── users.js       # Gestión de usuarios (admin)
│   ├── reports.js     # Reportes y exportación Excel (admin)
│   └── settings.js    # Configuración de la empresa
└── public/            # Frontend (HTML + CSS + JS vanilla)
```

## Deploy en Railway

1. Subí el repo a GitHub
2. Conectá el repo en [railway.app](https://railway.app)
3. Agregá un volumen con mount path `/app/data` para persistir la base de datos
4. Agregá la variable de entorno `SESSION_SECRET`
5. Railway genera la URL pública automáticamente
