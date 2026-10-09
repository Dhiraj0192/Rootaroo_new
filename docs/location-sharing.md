# Location sharing

Live location sharing lets a household member show where they are for a limited time. It lives in `src/modules/location-share` and is mounted at `/api/v1/location-shares` (signed in, plan active).

## Location sharing

- **Presets and limit**: the app offers 15 minutes, 1 hour and 8 hours. The server accepts any whole number of minutes from 1 to 480 (8 hours) and rejects more, both in validation and in the service.
- **One share at a time**: starting a share ends the person's previous one.
- **Audience**: `viewerIds` is either `null` (everyone else in the household) or a non-empty list of other household members. Only those people can see the share, and a person who has since left the household drops out automatically. The sharer is never in their own audience, and only the sharer can send positions or stop the share.
- **Answering a ping**: accepting a Ping with a duration starts a share visible only to the person who asked. The ping response carries `locationShareId`.
- **Endpoints**: `POST /` start, `GET /` returns `{ mine, visible }`, `POST /:id/location` sends the latest position, `POST /:id/stop` ends it. Updating or stopping a share that has ended or expired answers `410`, which tells the app to stop sending.
- **Realtime and push**: `location:share-started`, `location:update` and `location:share-ended` go to the sharer and the audience. Starting a share also sends a push to each audience member.
- **Expiry job**: `jobs/location-share-expiry.ts` runs every minute and ends shares past their time, so a phone that is off or offline still stops sharing on schedule.
- **Background behaviour**: whether positions keep flowing while the app is in the background is handled by the app. The server only stores what it is sent and ends the share on time.

## Privacy

- Only the latest position of an active share is stored. There is no history or trail.
- When a share ends (stopped, replaced or expired) its coordinates and accuracy are cleared; the row keeps only who shared with whom and when.
- Deleting a household or a user removes their shares.
