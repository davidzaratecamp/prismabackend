import mysql from 'mysql2/promise';
import { env } from '../src/config/env.js';

const { host, port, user, password, database } = env.db;

const connection = await mysql.createConnection({ host, port, user, password });
await connection.query(
  `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
);
console.log(`Base de datos "${database}" lista.`);
await connection.end();
