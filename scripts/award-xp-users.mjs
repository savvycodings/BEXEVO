import 'dotenv/config'
import pg from 'pg'
import { randomUUID } from 'crypto'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

/** exactName = case-insensitive exact display name; nameMatch = substring on name only */
const AWARDS = [
  { exactName: 'test', amount: 10 },
  { nameMatch: 'chalyn', amount: 20 },
]

async function awardXp(user, amount, label) {
  const sourceRef = `manual:${label}:${Date.now()}`
  await pool.query(
    `INSERT INTO user_gamification ("userId", "totalXp", "loginStreak", "lastLevel", "dayStartLevel", "updatedAt")
     VALUES ($1, 0, 0, 1, 1, NOW())
     ON CONFLICT ("userId") DO NOTHING`,
    [user.id]
  )

  await pool.query(
    `INSERT INTO xp_event (id, "userId", amount, source, "sourceRef", "createdAt")
     VALUES ($1, $2, $3, 'manual_grant', $4, NOW())`,
    [randomUUID(), user.id, amount, sourceRef]
  )

  const { rows } = await pool.query(
    `UPDATE user_gamification
     SET "totalXp" = "totalXp" + $2, "updatedAt" = NOW()
     WHERE "userId" = $1
     RETURNING "totalXp"`,
    [user.id, amount]
  )

  console.log(
    `Awarded ${amount} XP to ${user.name} (${user.email}) → total ${rows[0]?.totalXp ?? '?'}`
  )
}

async function main() {
  const { rows: users } = await pool.query(`
    SELECT u.id, u.name, u.email, p.username,
           COALESCE(g."totalXp", 0)::int AS xp
    FROM "user" u
    LEFT JOIN user_profile p ON p."userId" = u.id
    LEFT JOIN user_gamification g ON g."userId" = u.id
    ORDER BY u.name
  `)

  for (const award of AWARDS) {
    let user
    if (award.exactName) {
      const needle = award.exactName.toLowerCase()
      const matches = users.filter((u) => u.name?.toLowerCase() === needle)
      if (matches.length === 0) {
        console.error(`No user with exact name "${award.exactName}"`)
        continue
      }
      if (matches.length > 1) {
        console.warn(
          `Multiple users named "${award.exactName}" — using ${matches[0].email}:`,
          matches.map((m) => m.email).join(', ')
        )
      }
      user = matches[0]
    } else if (award.nameMatch) {
      const needle = award.nameMatch.toLowerCase()
      user = users.find((u) => u.name?.toLowerCase().includes(needle))
      if (!user) {
        console.error(`No user found with name containing "${award.nameMatch}"`)
        continue
      }
    }

    await awardXp(user, award.amount, award.exactName ?? award.nameMatch)
  }

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
