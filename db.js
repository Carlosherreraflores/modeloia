// Módulo de conexión a MySQL usando un pool de conexiones.
// Importar { query, pool, testConnection } desde este archivo para interactuar con la base de datos.

import mysql from 'mysql2/promise';
import 'dotenv/config';

export const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
});

// Función de conveniencia para ejecutar queries con parámetros
export async function query(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return { rows };
}

// Verifica la conexión al iniciar
export async function testConnection() {
    try {
        const [rows] = await pool.query('SELECT NOW() AS ahora');
        console.log(`✅ Base de datos MySQL conectada: ${rows[0].ahora}`);
    } catch (err) {
        console.error('❌ No se pudo conectar a la base de datos MySQL:', err.message);
        process.exit(1);
    }
}
