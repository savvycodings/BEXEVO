export type CoachStudentRole = "coach" | "student" | "none";

/** Role after admin revokes coach: student if linked to a coach, else none. */
export function roleAfterCoachRevoke(hasStudentLink: boolean): CoachStudentRole {
  return hasStudentLink ? "student" : "none";
}

export function adminHubPasswordValid(
  provided: string,
  expected: string
): boolean {
  const p = provided.trim();
  return p.length > 0 && p === expected;
}
