import { asc, eq, sql } from "drizzle-orm";
import { db, techniqueDrill } from "../db";
import {
  DEFAULT_DRILLS,
  localizeDrill,
  rankDrills,
  type DrillFocus,
  type DrillLang,
  type DrillOut,
  type DrillRow,
} from "./drillCatalog";

let seeded: Promise<void> | null = null;

/** Insert the default catalogue once, only when the table has no rows (edited rows are never overwritten). */
function ensureSeeded(): Promise<void> {
  seeded ??= (async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(techniqueDrill);
    if (n > 0) return;
    await db
      .insert(techniqueDrill)
      .values(DEFAULT_DRILLS.map((d) => ({ ...d })))
      .onConflictDoNothing();
  })().catch((err) => {
    seeded = null;
    throw err;
  });
  return seeded;
}

export async function listDrills(opts: {
  focus: DrillFocus[];
  shotLabel: string | null;
  lang: DrillLang;
  limit: number;
}): Promise<DrillOut[]> {
  await ensureSeeded();
  const rows = await db
    .select()
    .from(techniqueDrill)
    .where(eq(techniqueDrill.active, true))
    .orderBy(asc(techniqueDrill.sort));
  const catalogue: DrillRow[] = rows.map((r) => ({
    slug: r.slug,
    level: r.level as DrillRow["level"],
    minutes: r.minutes,
    focus: (r.focus ?? []) as DrillFocus[],
    shots: r.shots ?? [],
    videoUrl: r.videoUrl,
    sort: r.sort,
    content: r.content as DrillRow["content"],
  }));
  return rankDrills(catalogue, opts.focus, opts.shotLabel, opts.limit).map((d) => localizeDrill(d, opts.lang));
}
