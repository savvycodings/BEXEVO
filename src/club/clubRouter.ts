import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { randomUUID } from "crypto";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, club, clubAmenity, clubCourt, clubGalleryImage } from "../db";
import { adminHubPasswordValid } from "../profile/coachRole";
import {
  isValidClubAmenityKey,
  isValidClubCourtIndoorOutdoor,
  slugifyClubName,
  type ClubStatus,
} from "./clubDefinitions";

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const ADMIN_HUB_GATE_PASSWORD = process.env.ADMIN_HUB_GATE_PASSWORD || "xevodev";
const CLUB_IMAGE_UPLOAD_ROOT = path.join(process.cwd(), "uploads", "club");
const CLUB_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const CLUB_GALLERY_MAX_FILES = 12;

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CLUB_IMAGE_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || "").toLowerCase().startsWith("image/")) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed"));
  },
});

const galleryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CLUB_IMAGE_MAX_BYTES, files: CLUB_GALLERY_MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || "").toLowerCase().startsWith("image/")) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed"));
  },
});

function extForMime(mime: string, originalName?: string): string {
  const fromName = path.extname(originalName || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(fromName)) {
    return fromName === ".jpeg" ? ".jpg" : fromName;
  }
  const low = mime.toLowerCase();
  if (low.includes("png")) return ".png";
  if (low.includes("webp")) return ".webp";
  return ".jpg";
}

async function resolveUserId(req: express.Request): Promise<string | null> {
  const session = await auth.api
    .getSession({ headers: fromNodeHeaders(req.headers) })
    .catch(() => null);
  if (session?.user?.id) return session.user.id;

  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
  if (!bearerToken) return null;

  const sessionRow = await db.query.session.findFirst({
    where: (s, { eq: _eq }) => _eq(s.token, bearerToken),
  });
  return sessionRow?.userId ?? null;
}

function requireAdmin(req: express.Request): boolean {
  const provided = String(req.headers["x-xevo-admin-hub-password"] || "").trim();
  return adminHubPasswordValid(provided, ADMIN_HUB_GATE_PASSWORD);
}

async function loadCourtsAndAmenitiesAndGallery(clubId: string) {
  const [courts, amenities, gallery] = await Promise.all([
    db
      .select()
      .from(clubCourt)
      .where(eq(clubCourt.clubId, clubId))
      .orderBy(asc(clubCourt.displayOrder), asc(clubCourt.createdAt)),
    db.select().from(clubAmenity).where(eq(clubAmenity.clubId, clubId)),
    db
      .select()
      .from(clubGalleryImage)
      .where(eq(clubGalleryImage.clubId, clubId))
      .orderBy(asc(clubGalleryImage.displayOrder), asc(clubGalleryImage.createdAt)),
  ]);
  return { courts, amenities, gallery };
}

function serializeClub(
  row: typeof club.$inferSelect,
  extra: Awaited<ReturnType<typeof loadCourtsAndAmenitiesAndGallery>>
) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    address: row.address,
    city: row.city,
    region: row.region,
    country: row.country,
    postalCode: row.postalCode,
    latitude: row.latitude,
    longitude: row.longitude,
    phone: row.phone,
    email: row.email,
    website: row.website,
    hoursText: row.hoursText,
    bannerImageUrl: row.bannerImageUrl,
    logoImageUrl: row.logoImageUrl,
    status: row.status,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    courts: extra.courts.map((c) => ({
      id: c.id,
      name: c.name,
      indoorOutdoor: c.indoorOutdoor,
      hasLighting: c.hasLighting,
      displayOrder: c.displayOrder,
    })),
    amenityKeys: extra.amenities.map((a) => a.amenityKey),
    galleryImageUrls: extra.gallery.map((g) => g.imageUrl),
    gallery: extra.gallery.map((g) => ({ id: g.id, imageUrl: g.imageUrl })),
  };
}

async function loadOwnedClub(userId: string, clubId: string) {
  const row = await db.query.club.findFirst({
    where: (c, { and: _and, eq: _eq }) => _and(_eq(c.id, clubId), _eq(c.ownerUserId, userId)),
  });
  return row ?? null;
}

async function uniqueSlugForName(name: string): Promise<string> {
  const base = slugifyClubName(name) || "club";
  let candidate = base;
  for (let i = 1; i < 50; i++) {
    const existing = await db.query.club.findFirst({
      where: (c, { eq: _eq }) => _eq(c.slug, candidate),
    });
    if (!existing) return candidate;
    candidate = `${base}-${i + 1}`;
  }
  return `${base}-${randomUUID().slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// Authenticated (club owner) — "mine" routes, registered before the public
// `/:slug` catch-all so literal paths always win.
// ---------------------------------------------------------------------------

router.post("/", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const name = String(req.body?.name || "").trim();
    const address = String(req.body?.address || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!address) return res.status(400).json({ error: "address is required" });

    const id = randomUUID();
    const slug = await uniqueSlugForName(name);
    const now = new Date();

    await db.insert(club).values({
      id,
      ownerUserId: userId,
      name,
      slug,
      address,
      description: optionalString(req.body?.description),
      city: optionalString(req.body?.city),
      region: optionalString(req.body?.region),
      country: optionalString(req.body?.country),
      postalCode: optionalString(req.body?.postalCode),
      latitude: optionalString(req.body?.latitude),
      longitude: optionalString(req.body?.longitude),
      phone: optionalString(req.body?.phone),
      email: optionalString(req.body?.email),
      website: optionalString(req.body?.website),
      hoursText: optionalString(req.body?.hoursText),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    const row = await db.query.club.findFirst({ where: (c, { eq: _eq }) => _eq(c.id, id) });
    const extra = await loadCourtsAndAmenitiesAndGallery(id);
    return res.status(201).json({ club: serializeClub(row!, extra) });
  } catch (e: unknown) {
    console.error("[Club] create POST error", e);
    return res.status(500).json({ error: "Failed to create club" });
  }
});

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

router.get("/mine", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const rows = await db.query.club.findMany({
      where: (c, { eq: _eq }) => _eq(c.ownerUserId, userId),
      orderBy: (c, { desc: _desc }) => [_desc(c.createdAt)],
    });
    const clubs = await Promise.all(
      rows.map(async (row) => serializeClub(row, await loadCourtsAndAmenitiesAndGallery(row.id)))
    );
    return res.json({ clubs });
  } catch (e: unknown) {
    console.error("[Club] mine GET error", e);
    return res.status(500).json({ error: "Failed to load your clubs" });
  }
});

router.get("/mine/:id", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const row = await loadOwnedClub(userId, String(req.params.id || "").trim());
    if (!row) return res.status(404).json({ error: "Club not found" });

    const extra = await loadCourtsAndAmenitiesAndGallery(row.id);
    return res.json({ club: serializeClub(row, extra) });
  } catch (e: unknown) {
    console.error("[Club] mine/:id GET error", e);
    return res.status(500).json({ error: "Failed to load club" });
  }
});

const UPDATABLE_FIELDS = [
  "name",
  "description",
  "address",
  "city",
  "region",
  "country",
  "postalCode",
  "latitude",
  "longitude",
  "phone",
  "email",
  "website",
  "hoursText",
] as const;

router.patch("/mine/:id", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const clubId = String(req.params.id || "").trim();
    const existing = await loadOwnedClub(userId, clubId);
    if (!existing) return res.status(404).json({ error: "Club not found" });

    const patch: Record<string, string | null> = {};
    for (const field of UPDATABLE_FIELDS) {
      if (!(field in (req.body ?? {}))) continue;
      const value = optionalString(req.body[field]);
      patch[field] = value ?? null;
    }
    if (patch.name === null) return res.status(400).json({ error: "name cannot be empty" });
    if (patch.address === null) {
      return res.status(400).json({ error: "address cannot be empty" });
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    await db
      .update(club)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(club.id, clubId));

    const row = await db.query.club.findFirst({ where: (c, { eq: _eq }) => _eq(c.id, clubId) });
    const extra = await loadCourtsAndAmenitiesAndGallery(clubId);
    return res.json({ club: serializeClub(row!, extra) });
  } catch (e: unknown) {
    console.error("[Club] mine/:id PATCH error", e);
    return res.status(500).json({ error: "Failed to update club" });
  }
});

function imageUploadHandler(field: "bannerImageUrl" | "logoImageUrl", uploadDir: string) {
  return (req: express.Request, res: express.Response) => {
    imageUpload.single("image")(req, res, async (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : "Invalid upload";
        return res.status(400).json({ error: msg });
      }
      try {
        const userId = await resolveUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const clubId = String(req.params.id || "").trim();
        const existing = await loadOwnedClub(userId, clubId);
        if (!existing) return res.status(404).json({ error: "Club not found" });

        const file = req.file;
        if (!file?.buffer?.length) return res.status(400).json({ error: "No image file" });

        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const ext = extForMime(file.mimetype || "", file.originalname);
        const fileName = `${clubId}-${randomUUID()}${ext}`;
        await fs.promises.writeFile(path.join(uploadDir, fileName), file.buffer);
        const imageUrl = `/uploads/club/${path.basename(uploadDir)}/${fileName}`;

        await db
          .update(club)
          .set({ [field]: imageUrl, updatedAt: new Date() })
          .where(eq(club.id, clubId));

        return res.json({ ok: true, imageUrl });
      } catch (e: unknown) {
        console.error(`[Club] ${field} upload error`, e);
        return res.status(500).json({ error: "Failed to upload image" });
      }
    });
  };
}

router.post(
  "/mine/:id/banner",
  imageUploadHandler("bannerImageUrl", path.join(CLUB_IMAGE_UPLOAD_ROOT, "banner"))
);
router.post(
  "/mine/:id/logo",
  imageUploadHandler("logoImageUrl", path.join(CLUB_IMAGE_UPLOAD_ROOT, "logo"))
);

router.post("/mine/:id/gallery", (req, res) => {
  galleryUpload.array("photos", CLUB_GALLERY_MAX_FILES)(req, res, async (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : "Invalid upload";
      return res.status(400).json({ error: msg });
    }
    try {
      const userId = await resolveUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const clubId = String(req.params.id || "").trim();
      const existing = await loadOwnedClub(userId, clubId);
      if (!existing) return res.status(404).json({ error: "Club not found" });

      const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      if (files.length === 0) return res.status(400).json({ error: "No photo files" });

      const uploadDir = path.join(CLUB_IMAGE_UPLOAD_ROOT, "gallery");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      const existingRows = await db
        .select({ displayOrder: clubGalleryImage.displayOrder })
        .from(clubGalleryImage)
        .where(eq(clubGalleryImage.clubId, clubId))
        .orderBy(asc(clubGalleryImage.displayOrder));
      let nextOrder =
        existingRows.length > 0
          ? Math.max(...existingRows.map((r) => r.displayOrder)) + 1
          : 0;

      const inserted: string[] = [];
      for (const file of files) {
        if (!file?.buffer?.length) continue;
        const ext = extForMime(file.mimetype || "", file.originalname);
        const fileName = `${clubId}-${randomUUID()}${ext}`;
        await fs.promises.writeFile(path.join(uploadDir, fileName), file.buffer);
        const imageUrl = `/uploads/club/gallery/${fileName}`;
        await db.insert(clubGalleryImage).values({
          id: randomUUID(),
          clubId,
          imageUrl,
          displayOrder: nextOrder++,
          createdAt: new Date(),
        });
        inserted.push(imageUrl);
      }
      if (inserted.length === 0) return res.status(400).json({ error: "No valid photo files" });

      return res.status(201).json({ ok: true, imageUrls: inserted });
    } catch (e: unknown) {
      console.error("[Club] gallery upload error", e);
      return res.status(500).json({ error: "Failed to upload gallery photos" });
    }
  });
});

router.delete("/mine/:id/gallery/:imageId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const clubId = String(req.params.id || "").trim();
    const existing = await loadOwnedClub(userId, clubId);
    if (!existing) return res.status(404).json({ error: "Club not found" });

    await db
      .delete(clubGalleryImage)
      .where(
        and(
          eq(clubGalleryImage.id, String(req.params.imageId || "").trim()),
          eq(clubGalleryImage.clubId, clubId)
        )
      );
    return res.json({ ok: true });
  } catch (e: unknown) {
    console.error("[Club] gallery delete error", e);
    return res.status(500).json({ error: "Failed to remove gallery photo" });
  }
});

router.post("/mine/:id/courts", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const clubId = String(req.params.id || "").trim();
    const existing = await loadOwnedClub(userId, clubId);
    if (!existing) return res.status(404).json({ error: "Club not found" });

    const name = String(req.body?.name || "").trim();
    const indoorOutdoor = String(req.body?.indoorOutdoor || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!isValidClubCourtIndoorOutdoor(indoorOutdoor)) {
      return res.status(400).json({ error: "indoorOutdoor must be indoor, outdoor, or covered" });
    }
    const hasLighting = Boolean(req.body?.hasLighting);

    const existingCourts = await db
      .select({ displayOrder: clubCourt.displayOrder })
      .from(clubCourt)
      .where(eq(clubCourt.clubId, clubId));
    const displayOrder =
      existingCourts.length > 0 ? Math.max(...existingCourts.map((c) => c.displayOrder)) + 1 : 0;

    const id = randomUUID();
    const now = new Date();
    await db.insert(clubCourt).values({
      id,
      clubId,
      name,
      indoorOutdoor,
      hasLighting,
      displayOrder,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(201).json({ court: { id, name, indoorOutdoor, hasLighting, displayOrder } });
  } catch (e: unknown) {
    console.error("[Club] court create error", e);
    return res.status(500).json({ error: "Failed to add court" });
  }
});

router.patch("/mine/:id/courts/:courtId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const clubId = String(req.params.id || "").trim();
    const existing = await loadOwnedClub(userId, clubId);
    if (!existing) return res.status(404).json({ error: "Club not found" });

    const patch: Record<string, string | boolean> = {};
    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      patch.name = req.body.name.trim();
    }
    if (typeof req.body?.indoorOutdoor === "string") {
      if (!isValidClubCourtIndoorOutdoor(req.body.indoorOutdoor)) {
        return res.status(400).json({ error: "indoorOutdoor must be indoor, outdoor, or covered" });
      }
      patch.indoorOutdoor = req.body.indoorOutdoor;
    }
    if ("hasLighting" in (req.body ?? {})) {
      patch.hasLighting = Boolean(req.body.hasLighting);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    await db
      .update(clubCourt)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(clubCourt.id, String(req.params.courtId || "").trim()),
          eq(clubCourt.clubId, clubId)
        )
      );
    return res.json({ ok: true });
  } catch (e: unknown) {
    console.error("[Club] court update error", e);
    return res.status(500).json({ error: "Failed to update court" });
  }
});

router.delete("/mine/:id/courts/:courtId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const clubId = String(req.params.id || "").trim();
    const existing = await loadOwnedClub(userId, clubId);
    if (!existing) return res.status(404).json({ error: "Club not found" });

    await db
      .delete(clubCourt)
      .where(
        and(
          eq(clubCourt.id, String(req.params.courtId || "").trim()),
          eq(clubCourt.clubId, clubId)
        )
      );
    return res.json({ ok: true });
  } catch (e: unknown) {
    console.error("[Club] court delete error", e);
    return res.status(500).json({ error: "Failed to remove court" });
  }
});

/** Replaces the club's full amenity set with `keys` (simpler than granular add/remove for a
 * checklist UI: the client always PUTs the complete checked list). */
router.put("/mine/:id/amenities", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const clubId = String(req.params.id || "").trim();
    const existing = await loadOwnedClub(userId, clubId);
    if (!existing) return res.status(404).json({ error: "Club not found" });

    const body: { keys?: unknown } = req.body ?? {};
    const rawKeys: unknown[] | null = Array.isArray(body.keys) ? body.keys : null;
    if (!rawKeys) return res.status(400).json({ error: "keys must be an array" });

    const keys: string[] = Array.from(new Set(rawKeys.map((k) => String(k).trim())));
    const invalid = keys.filter((k) => !isValidClubAmenityKey(k));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Unknown amenity keys: ${invalid.join(", ")}` });
    }

    await db.delete(clubAmenity).where(eq(clubAmenity.clubId, clubId));
    if (keys.length > 0) {
      await db.insert(clubAmenity).values(
        keys.map((amenityKey) => ({
          id: randomUUID(),
          clubId,
          amenityKey,
          createdAt: new Date(),
        }))
      );
    }
    return res.json({ ok: true, amenityKeys: keys });
  } catch (e: unknown) {
    console.error("[Club] amenities PUT error", e);
    return res.status(500).json({ error: "Failed to update amenities" });
  }
});

// ---------------------------------------------------------------------------
// Admin (shared-secret header, same pattern as profileRouter's admin-grant-coach)
// ---------------------------------------------------------------------------

router.get("/admin/pending", async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "Invalid admin password" });
  try {
    const rows = await db.query.club.findMany({
      where: (c, { inArray: _inArray }) => _inArray(c.status, ["pending", "rejected"]),
      orderBy: (c, { asc: _asc }) => [_asc(c.createdAt)],
    });
    const clubs = await Promise.all(
      rows.map(async (row) => serializeClub(row, await loadCourtsAndAmenitiesAndGallery(row.id)))
    );
    return res.json({ clubs });
  } catch (e: unknown) {
    console.error("[Club] admin/pending GET error", e);
    return res.status(500).json({ error: "Failed to load pending clubs" });
  }
});

async function setClubStatus(
  req: express.Request,
  res: express.Response,
  status: Extract<ClubStatus, "approved" | "rejected">
) {
  if (!requireAdmin(req)) return res.status(403).json({ error: "Invalid admin password" });
  try {
    const clubId = String(req.params.id || "").trim();
    const existing = await db.query.club.findFirst({
      where: (c, { eq: _eq }) => _eq(c.id, clubId),
    });
    if (!existing) return res.status(404).json({ error: "Club not found" });

    const rejectionReason =
      status === "rejected" ? optionalString(req.body?.reason) ?? null : null;

    await db
      .update(club)
      .set({
        status,
        reviewedAt: new Date(),
        rejectionReason,
        updatedAt: new Date(),
      })
      .where(eq(club.id, clubId));

    return res.json({ ok: true, status });
  } catch (e: unknown) {
    console.error(`[Club] admin ${status} error`, e);
    return res.status(500).json({ error: `Failed to mark club ${status}` });
  }
}

router.post("/admin/:id/approve", (req, res) => setClubStatus(req, res, "approved"));
router.post("/admin/:id/reject", (req, res) => setClubStatus(req, res, "rejected"));

// ---------------------------------------------------------------------------
// Public — approved clubs only. Registered last so the literal routes above
// always win over this single-segment catch-all.
// ---------------------------------------------------------------------------

router.get("/", async (_req, res) => {
  try {
    const rows = await db.query.club.findMany({
      where: (c, { eq: _eq }) => _eq(c.status, "approved" satisfies ClubStatus),
      orderBy: (c, { desc: _desc }) => [_desc(c.createdAt)],
    });
    const clubs = await Promise.all(
      rows.map(async (row) => serializeClub(row, await loadCourtsAndAmenitiesAndGallery(row.id)))
    );
    return res.json({ clubs });
  } catch (e: unknown) {
    console.error("[Club] list GET error", e);
    return res.status(500).json({ error: "Failed to load clubs" });
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const row = await db.query.club.findFirst({
      where: (c, { and: _and, eq: _eq }) =>
        _and(_eq(c.slug, slug), _eq(c.status, "approved" satisfies ClubStatus)),
    });
    if (!row) return res.status(404).json({ error: "Club not found" });

    const extra = await loadCourtsAndAmenitiesAndGallery(row.id);
    return res.json({ club: serializeClub(row, extra) });
  } catch (e: unknown) {
    console.error("[Club] detail GET error", e);
    return res.status(500).json({ error: "Failed to load club" });
  }
});

export default router;
