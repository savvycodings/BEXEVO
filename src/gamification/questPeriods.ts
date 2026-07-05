import { localDateKey } from "./stats";

export type QuestCadence = "daily" | "weekly" | "season";

/** ISO week (Monday start), e.g. `W2026-23`. */
export function weeklyPeriodKey(d: Date = new Date()): string {
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return `W${utc.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

/** Four-month seassons blocks: Jan–Apr, May–Aug, Sep–Dec. e.g. `S2026-2`. */
export function seasonPeriodKey(d: Date = new Date()): string {
  const season = Math.floor(d.getMonth() / 4) + 1;
  return `S${d.getFullYear()}-${season}`;
}

export function periodKeyForCadence(
  cadence: QuestCadence,
  d: Date = new Date()
): string {
  if (cadence === "daily") return localDateKey(d);
  if (cadence === "weekly") return weeklyPeriodKey(d);
  return seasonPeriodKey(d);
}

export function cadenceFromPeriodKey(periodKey: string): QuestCadence {
  if (periodKey.startsWith("W")) return "weekly";
  if (periodKey.startsWith("S")) return "season";
  return "daily";
}

function addDaysKey(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateKey(dt);
}

function isoWeekBounds(
  year: number,
  week: number
): { start: string; end: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const monday = new Date(mondayWeek1);
  monday.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (dt: Date) =>
    localDateKey(new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  return { start: fmt(monday), end: fmt(sunday) };
}

function seasonBounds(
  year: number,
  season: number
): { start: string; end: string } {
  const startMonth = (season - 1) * 4;
  const endMonth = startMonth + 3;
  const start = `${year}-${String(startMonth + 1).padStart(2, "0")}-01`;
  const endDate = new Date(year, endMonth + 1, 0);
  return { start, end: localDateKey(endDate) };
}

/** Inclusive local-date bounds for a quest period key. */
export function periodBounds(periodKey: string): { start: string; end: string } {
  if (periodKey.startsWith("W")) {
    const [, yw] = periodKey.split("W");
    const [yearStr, weekStr] = yw.split("-");
    return isoWeekBounds(Number(yearStr), Number(weekStr));
  }
  if (periodKey.startsWith("S")) {
    const [, ys] = periodKey.split("S");
    const [yearStr, seasonStr] = ys.split("-");
    return seasonBounds(Number(yearStr), Number(seasonStr));
  }
  return { start: periodKey, end: periodKey };
}

export function dateKeyInPeriod(
  dateKey: string,
  periodKey: string
): boolean {
  const { start, end } = periodBounds(periodKey);
  return dateKey >= start && dateKey <= end;
}

export function previousPeriodKey(
  cadence: QuestCadence,
  periodKey: string
): string {
  if (cadence === "daily") {
    return addDaysKey(periodKey, -1);
  }
  if (cadence === "weekly") {
    const { start } = periodBounds(periodKey);
    return weeklyPeriodKey(
      new Date(
        Number(start.slice(0, 4)),
        Number(start.slice(5, 7)) - 1,
        Number(start.slice(8, 10)) - 7
      )
    );
  }
  const [, ys] = periodKey.split("S");
  const [yearStr, seasonStr] = ys.split("-");
  let year = Number(yearStr);
  let season = Number(seasonStr) - 1;
  if (season < 1) {
    season = 3;
    year -= 1;
  }
  return `S${year}-${season}`;
}
