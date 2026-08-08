import { resolve } from 'node:path'
import { migrations, openDb } from './migrations'

export const db = openDb(resolve(process.env.DB_PATH ?? './scarab.db'))
export const schemaVersion = migrations.length
