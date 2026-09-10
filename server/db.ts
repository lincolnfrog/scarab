import { resolve } from 'node:path'
import { migrations, openDb } from './migrations'

const path = process.env.DB_PATH ?? './scarab.db'
export const db = openDb(path === ':memory:' ? path : resolve(path))
export const schemaVersion = migrations.length
