import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';

/**
 * @param {import('knex').Knex} knex
 */
export async function seed(knex) {
  const { name, email, password } = env.seedAdmin;
  const existing = await knex('users').where({ email }).first();
  if (existing) {
    console.log(`Usuario admin "${email}" ya existe, no se modifica la contraseña.`);
    return;
  }
  const password_hash = await bcrypt.hash(password, 10);
  await knex('users').insert({
    name,
    email,
    password_hash,
    role: 'admin',
    avatar_color: '#6366f1',
    is_active: true,
  });
  console.log('----------------------------------------------------------');
  console.log('  Usuario admin creado');
  console.log(`  Email:      ${email}`);
  console.log(`  Contraseña: ${password}`);
  console.log('  Cámbiala tras el primer inicio de sesión (Ajustes).');
  console.log('----------------------------------------------------------');
}
