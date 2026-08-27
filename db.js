// Módulo de conexión a PostgreSQL usando un pool de conexiones.
// Importar { query, pool, testConnection } desde este archivo para interactuar con la base de datos.

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     parseInt(process.env.DB_PORT || '5432'),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Función de conveniencia para ejecutar queries con parámetros
export async function query(sql, params = []) {
    const result = await pool.query(sql, params);
    return { rows: result.rows };
}

// Verifica la conexión al iniciar
export async function testConnection() {
    try {
        const result = await pool.query('SELECT NOW() AS ahora');
        console.log(`✅ Base de datos PostgreSQL conectada: ${result.rows[0].ahora}`);
    } catch (err) {
        console.error('❌ No se pudo conectar a la base de datos PostgreSQL:', err.message);
        process.exit(1);
    }
}
