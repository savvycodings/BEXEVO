# Drill progression videos (Railway)

## Storage

- Railway bucket: `xevo-drills`
- Object keys: `drills/{shot}/{file}.mp4` (e.g. `drills/bandeja/01-primary.mp4`)
- Shots currently uploaded: `bandeja`, `remate-plano`, `remate-liftado`, `volea-derecha`, `volea-reves`
- Public stream (via BEXEVO): `GET /drills/media/{shot}/{file}`
  - Example: `https://bexevo-production.up.railway.app/drills/media/bandeja/01-primary.mp4`
- Bulk upload: `node scripts/upload-drills-media.mjs` (needs `DRILLS_UPLOAD_SECRET`)

## Env on BEXEVO

| Variable | Source |
|----------|--------|
| `DRILLS_S3_ENDPOINT` | `${{xevo-drills.ENDPOINT}}` |
| `DRILLS_S3_BUCKET` | `${{xevo-drills.BUCKET}}` |
| `DRILLS_S3_REGION` | `${{xevo-drills.REGION}}` |
| `DRILLS_S3_ACCESS_KEY_ID` | `${{xevo-drills.ACCESS_KEY_ID}}` |
| `DRILLS_S3_SECRET_ACCESS_KEY` | `${{xevo-drills.SECRET_ACCESS_KEY}}` |
| `DRILLS_UPLOAD_SECRET` | Shared secret for `POST /drills/media/upload` |

## Deploy note

Railway production deploys from **`savvycodings/BEXEVO`**. This workspace remote is `Xevo-Sports/BEXevo` — sync/push the drills media router there so Railway picks it up.

## Upload

```bash
curl -X POST "https://bexevo-production.up.railway.app/drills/media/upload" \
  -H "x-drills-upload-secret: $DRILLS_UPLOAD_SECRET" \
  -F "key=bandeja/01-primary.mp4" \
  -F "file=@./video.mp4"
```
