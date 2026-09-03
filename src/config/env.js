import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

// Carga backend/.env sin importar desde qué directorio se ejecute el proceso.
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(backendRoot, '.env') });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim()),

  db: {
    host: required('DB_HOST', '127.0.0.1'),
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER', 'root'),
    password: process.env.DB_PASSWORD || '',
    database: required('DB_NAME', 'prisma_db'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },

  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Administrador',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@prisma.local',
    password: process.env.SEED_ADMIN_PASSWORD || 'PrismaAdmin2026!',
  },

  // Retell AI — analítica de agentes de voz del proveedor de IA (panel solo-admin).
  // La API key es opcional: sin ella el panel funciona en solo-lectura sobre lo ya
  // sincronizado y el botón "Sincronizar" responde 503.
  retell: {
    apiKey: process.env.RETELL_API_KEY || '',
    baseUrl: process.env.RETELL_BASE_URL || 'https://api.retellai.com',
    syncLookbackDays: Number(process.env.RETELL_SYNC_LOOKBACK_DAYS || 90),
  },

  // Aware / SOFIA — analítica de inbound Claro Hogar y TyT (rol `analista`).
  // Consulta directa (solo lectura) a la BD PostgreSQL de Aware. Opcional: sin
  // AWARE_DB_HOST el panel responde 503.
  aware: {
    host: process.env.AWARE_DB_HOST || '',
    port: Number(process.env.AWARE_DB_PORT || 5432),
    database: process.env.AWARE_DB_NAME || 'awareccm',
    user: process.env.AWARE_DB_USER || 'analista',
    password: process.env.AWARE_DB_PASSWORD || '',
    audioBaseUrl: process.env.AWARE_AUDIO_BASE_URL || 'https://asiste.awareccm.com/audiofiles',
    // Token compartido con VoxPro para recibir el snapshot de calidad IA (push).
    voxproToken: process.env.VOXPRO_ANALYTICS_TOKEN || '',
  },
};

export const isDev = env.nodeEnv === 'development';
