# Push campaigns

Scheduled nudges sent by the server (not tied to something a household member just did).

## Rules (highest priority first)

| Rule | Who gets it |
|------|-------------|
| `task_due_tomorrow` | Assignee of an unfinished task due tomorrow (household time) |
| `new_member_first_post` | Joined 2-7 days ago and has not posted yet |
| `no_checkin_today` | Every member of a household with 2+ members, after 18:00 household time, when nobody has checked in that day |
| `inactive_7d` | No app activity for 7-30 days |
| `inactive_3d` | No app activity for 3-7 days |

Only households with an active entitlement are considered. Activity is the most recent time any of the user's devices was seen.

## Limits

- At most 2 campaign pushes per user in any rolling 7 days.
- One campaign push per user per run (the job runs hourly); the highest-priority rule wins.
- The same rule is never sent to a user twice within 7 days, and the line used last time for a rule is not repeated.
- Quiet hours: nothing from 21:00 to 08:00 in the household's timezone.
- Users can switch these off with the "Tips and nudges" notification preference (`tips`).

## Kill switch

Set `CAMPAIGNS_ENABLED=false` in the server environment and restart to stop campaign pushes. Unset or any other value leaves them on.

## Admin controls

Every campaign is off until an admin switches it on. There is a master switch (`all`), one switch per rule, and one for signed-out nudges (`signed_out_nudges`). A rule sends only when `all` and its own switch are both on. If the settings cannot be read, everything counts as off. `CAMPAIGNS_ENABLED=false` stays as the hard kill switch for the job and overrides these.

These use the admin API key (`x-admin-api-key`) and every change is audit-logged with the key label. The admin panel (planned) will surface the same controls.

```
# Review the copy and see every switch (and who changed it last)
curl -H "x-admin-api-key: $ADMIN_API_KEY" https://<host>/api/v1/admin/campaigns

# Switch one rule, the master, or signed-out nudges on or off
curl -X PUT -H "x-admin-api-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"enabled": true}' https://<host>/api/v1/admin/campaigns/inactive_3d
curl -X PUT -H "x-admin-api-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"enabled": true}' https://<host>/api/v1/admin/campaigns/all
```

Keys: `all`, `task_due_tomorrow`, `new_member_first_post`, `no_checkin_today`, `inactive_7d`, `inactive_3d`, `signed_out_nudges`. An unknown key or a non-boolean `enabled` is a 400.

The app reads the signed-out switch from the public `GET /api/v1/campaigns/signed-out` (`{ success, data: { enabled } }`, cached for 5 minutes).

## Where things live

- Copy deck and line picking: `server/src/modules/campaign/copy.ts`
- Cap, quiet hours and rule choice: `server/src/modules/campaign/select.ts`
- Candidate queries and the run loop: `server/src/modules/campaign/run.ts`
- Admin switches: `server/src/modules/campaign/settings.ts`, `campaign_settings` table
- Schedule: `server/src/jobs/campaigns.ts`
- Send log (cap and no-repeat): `campaign_sends` table
