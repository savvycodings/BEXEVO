import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import pg from 'pg'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

for (const file of ['0032_user_gamification.sql', '0033_user_achievement_claimed_at.sql']) {
  const sql = fs.readFileSync(path.join(__dirname, '../drizzle', file), 'utf8')
  console.log('Applying', file)
  await pool.query(sql)
}

await pool.end()
console.log('Done')
