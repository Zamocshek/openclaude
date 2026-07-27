# YouTube via Maton

Choose the app before requesting a connection. Do not mix connection IDs across
the three YouTube apps.

| App | Use it for | Read-first route |
|---|---|---|
| `youtube` | Channel, videos, playlists, subscriptions, comments | `youtube/v3/channels?part=snippet,statistics&mine=true` |
| `youtube-analytics` | Channel metrics and groups | `v2/reports?ids=channel==MINE&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&metrics=views,likes,comments` |
| `youtube-reporting` | Bulk-report types, jobs, and downloads | `v1/reportTypes?pageSize=10` |

## Read Workflow

1. Call `maton_connections(app="youtube")`, `youtube-analytics`, or
   `youtube-reporting`.
2. Select one active `connection_id` explicitly.
3. Call `maton_get` with a relative route from the table. Do not use a full URL.
4. For pagination, keep the returned `nextPageToken` and pass it as
   `pageToken` in the next request.

Common Data API reads:

```text
youtube/v3/search?part=snippet&q=QUERY&type=video&maxResults=10
youtube/v3/videos?part=snippet,statistics,contentDetails&id=VIDEO_ID
youtube/v3/playlists?part=snippet,contentDetails&mine=true&maxResults=25
youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=PLAYLIST_ID&maxResults=50
youtube/v3/commentThreads?part=snippet,replies&videoId=VIDEO_ID&maxResults=100
```

Use the smallest useful result set. YouTube search costs more quota than basic
channel, video, or playlist reads.

## Write Workflow

Use `maton_prepare_request`, not `maton_get`, for rating a video, creating or
deleting a playlist, changing playlist items, subscribing, creating a comment,
or creating/updating/deleting Analytics or Reporting resources. Include the
exact app, connection, relative route, JSON body, and human-readable outcome.
Only call `assistant_confirm_action` after the user approves the exact action.

Read the complete provider route reference immediately before forming a request:

- `maton skills for telegram/references/youtube/README.md`
- `maton skills for telegram/references/youtube-analytics/README.md`
- `maton skills for telegram/references/youtube-reporting/README.md`
