import { get } from '../database/datenbank.js';
import { readStatistics } from './statistics-reader.js';

export async function getStatistics() {
    return readStatistics({ get });
}
