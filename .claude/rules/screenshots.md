---
paths:
  - lib/screenshots.js
  - index.html
  - tests/screenshots.spec.js
---

# Screenshot feature rules

The screenshot feature captures the current dashboard view, saves it to the user's reports tab for future reference, and allows it to be downloaded.

## Hard rules

- **Screenshots are user-scoped, no exceptions.** Each screenshot row in the database has a `user_id` column. RLS policy: users can only SELECT/INSERT/DELETE their own screenshots. User A must never see, list, or download a screenshot belonging to user B.

- **Screenshot files live in Supabase Storage, in a per-user folder.** Bucket structure: `screenshots/<user_id>/<screenshot_id>.png`. The Storage bucket has its own RLS policy mirroring the database table — a user can only access objects under their own user_id prefix.

- **The download URL is a signed URL with a short expiry** (15 minutes is plenty). Never expose the bucket as public. Generate a fresh signed URL each time the user clicks download.

- **Capture method**: use `html2canvas` (loaded via CDN, consistent with the no-build-step architecture). After capture, the resulting blob uploads to Storage; the row in the `screenshots` table records `{id, user_id, created_at, storage_path, label}`.

- **Capture, upload, save the row** is one logical operation. If upload succeeds but the row insert fails, delete the orphan upload. If the row insert succeeds but the user navigates away mid-upload, the row should not exist (insert AFTER upload confirms). No orphans either way.

- **The reports tab lists screenshots by `created_at desc`, paginated.** Don't load all screenshots in one query — a power user could accumulate hundreds. Page size: 20.

## Required tests when modifying these files

`tests/screenshots.spec.js` must contain and pass:

1. **Capture and persist**: take a screenshot in the dashboard, verify it appears in the reports tab, reload the page, verify it's still there.
2. **Download**: from the reports tab, click download, verify the file downloads and is a valid PNG.
3. **User isolation**: log in as user A, take a screenshot. Log in as user B. Verify user B's reports tab is empty AND that user B cannot access user A's screenshot by guessing the storage path or screenshot ID in a direct request.
4. **Orphan prevention**: simulate a Storage upload that succeeds and a database insert that fails. Verify the storage object is cleaned up and not left orphaned.
5. **Mobile capture**: take a screenshot on a 375px-width viewport. Verify the captured image is reasonable (not cut off, not blank).

## Things that look fine but aren't

- "We can just give it a random URL, no one will guess it" — security through obscurity is not security. Use signed URLs.
- "html2canvas missed some elements" — known limitation with iframes and cross-origin images. Document it in the test and pick a capture strategy that works for the actual dashboard content. Verify with a real visual snapshot in the test.
