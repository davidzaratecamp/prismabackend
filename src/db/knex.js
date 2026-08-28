import knexFactory from 'knex';
import knexConfig from '../../knexfile.js';

export const db = knexFactory(knexConfig);
