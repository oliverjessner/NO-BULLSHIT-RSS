import sqlite3 from '@vscode/sqlite3';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => db.run('PRAGMA foreign_keys = ON'));

export function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

export function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

export function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

export async function initSchema() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = await readFile(schemaPath, 'utf-8');

    return new Promise((resolve, reject) => {
        db.exec(schemaSql, err => {
            if (err) return reject(err);
            resolve();
        });
    });
}

export async function ensureFeedLogoColumns() {
    const columns = await all('PRAGMA table_info(feeds)');
    const hasLogo = columns.some(col => col.name === 'logo');
    const hasLogoMime = columns.some(col => col.name === 'logoMime');

    if (!hasLogo) await run('ALTER TABLE feeds ADD COLUMN logo BLOB');
    if (!hasLogoMime) await run('ALTER TABLE feeds ADD COLUMN logoMime TEXT');
}

export async function ensureListColorColumn() {
    const columns = await all('PRAGMA table_info(lists)');
    const hasColor = columns.some(col => col.name === 'color');

    if (!hasColor) await run("ALTER TABLE lists ADD COLUMN color TEXT NOT NULL DEFAULT '#1d1d1f'");

    await run("UPDATE lists SET color = '#1d1d1f' WHERE color IS NULL OR color = ''");
}

export default db;
