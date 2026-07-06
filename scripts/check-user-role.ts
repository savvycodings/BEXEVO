import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db, user, userProfile, coachStudent } from "../src/db";

async function main() {
  const args = process.argv.slice(2);
  const removeStudentLinks = args.includes("--remove-student-links");
  const email = args.find((a) => !a.startsWith("--")) ?? "knoome@proton.me";

  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      coachStudentRole: userProfile.coachStudentRole,
    })
    .from(user)
    .leftJoin(userProfile, eq(user.id, userProfile.userId))
    .where(sql`lower(${user.email}) = lower(${email})`);

  console.log("user:", JSON.stringify(rows, null, 2));

  const userId = rows[0]?.id;
  if (!userId) {
    console.log("No user found for email:", email);
    return;
  }

  const asStudent = await db
    .select({
      linkId: coachStudent.id,
      coachUserId: coachStudent.coachUserId,
      coachEmail: user.email,
      coachName: user.name,
      createdAt: coachStudent.createdAt,
    })
    .from(coachStudent)
    .innerJoin(user, eq(coachStudent.coachUserId, user.id))
    .where(eq(coachStudent.studentUserId, userId));

  const asCoach = await db
    .select({
      linkId: coachStudent.id,
      studentUserId: coachStudent.studentUserId,
      studentEmail: user.email,
      studentName: user.name,
      createdAt: coachStudent.createdAt,
    })
    .from(coachStudent)
    .innerJoin(user, eq(coachStudent.studentUserId, user.id))
    .where(eq(coachStudent.coachUserId, userId));

  console.log("linked coaches (this user is student):", JSON.stringify(asStudent, null, 2));
  console.log("linked students (this user is coach):", JSON.stringify(asCoach, null, 2));

  if (rows[0]?.coachStudentRole === "coach") {
    const hasStudentLink = asStudent.length > 0;
    const nextRole = hasStudentLink ? "student" : "none";
    console.log(`Role is coach — demoting to ${nextRole}...`);
    await db
      .update(userProfile)
      .set({ coachStudentRole: nextRole })
      .where(eq(userProfile.userId, userId));
    console.log("Done.");
  }

  if (removeStudentLinks && asStudent.length > 0) {
    console.log(`Removing ${asStudent.length} coach_student row(s) where user is student...`);
    await db.delete(coachStudent).where(eq(coachStudent.studentUserId, userId));
    const role = rows[0]?.coachStudentRole;
    if (role === "student") {
      await db
        .update(userProfile)
        .set({ coachStudentRole: "none" })
        .where(eq(userProfile.userId, userId));
      console.log("Set coachStudentRole to none.");
    }
    console.log("Done.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
