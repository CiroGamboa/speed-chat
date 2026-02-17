# Testing Guide - Firebase Migration

This guide will help you test the Firebase migration to ensure all sync issues are resolved.

## Prerequisites

1. Complete the Firebase setup as described in `FIREBASE_SETUP.md`
2. Update the Firebase config in `index.html` with your actual Firebase credentials
3. Deploy the updated `index.html` to GitHub Pages or test locally

## Test Scenarios

### Test 1: Basic Sync - Adding People to Lines

**Goal:** Verify that changes made by one user appear instantly for all other users.

1. Open the app in **Browser Window 1** (Chrome)
2. Open the app in **Browser Window 2** (Firefox or Chrome Incognito)
3. In Window 1:
   - Add a new line (e.g., "Line A")
   - Add a person to the line (e.g., "John")
4. In Window 2:
   - Verify "Line A" appears automatically
   - Verify "John" appears in the line
5. In Window 2:
   - Add another person to "Line A" (e.g., "Jane")
6. In Window 1:
   - Verify "Jane" appears in the line

**Expected Result:** All changes should appear in both windows within 1-2 seconds, no refresh needed.

### Test 2: Per-Line Wait Queue Persistence

**Goal:** Verify that per-line wait queues are now properly saved and synced (this was broken before).

1. In Window 1:
   - Create a line "Line B"
   - Add people until the line is full (reaches max people per line)
   - Add one more person - they should go to the line's wait queue
2. In Window 2:
   - Verify the wait queue indicator appears
   - Verify the person is in the wait queue, not the active line
3. Close both browser windows
4. Reopen the app in a new window
5. Navigate to "Line B"
   - Verify the wait queue person is still there

**Expected Result:** Wait queues should persist and sync correctly across all clients.

### Test 3: Concurrent Modifications

**Goal:** Verify that simultaneous edits don't cause data loss or conflicts.

1. Open the app in **3 browser windows**
2. In all three windows simultaneously (within 1-2 seconds):
   - Window 1: Add person "Alice" to Line A
   - Window 2: Add person "Bob" to Line A
   - Window 3: Add person "Charlie" to Line A
3. Wait 5 seconds
4. In all three windows:
   - Verify all three people (Alice, Bob, Charlie) appear in Line A
   - Verify no duplicates or missing people

**Expected Result:** All three people should appear in all windows. No data loss.

### Test 4: Configuration Changes

**Goal:** Verify configuration changes sync across all users.

1. In Window 1:
   - Click settings (gear icon)
   - Change "Session Duration" to 20 minutes
   - Change "Alarm Interval" to 3 minutes
   - Save changes
2. In Window 2:
   - Open settings
   - Verify "Session Duration" shows 20
   - Verify "Alarm Interval" shows 3

**Expected Result:** Configuration changes should appear in all windows immediately.

### Test 5: Removing People

**Goal:** Verify deletions sync correctly.

1. In Window 1:
   - Remove "Alice" from Line A
2. In Window 2:
   - Verify "Alice" disappears from Line A

**Expected Result:** Deletions should sync immediately without requiring refresh.

### Test 6: Connection Loss and Reconnection

**Goal:** Verify the app handles temporary connection loss gracefully.

1. Open the app in Window 1
2. Add a line and a few people
3. Open Developer Tools (F12) → Network tab
4. Select "Offline" to simulate connection loss
5. Try to add a person (you should see an error)
6. Uncheck "Offline" to restore connection
7. Wait a few seconds
8. Add another person
9. Open Window 2
   - Verify all data appears correctly

**Expected Result:** App should handle offline gracefully and resume syncing when connection is restored.

### Test 7: Page Refresh During Event

**Goal:** Verify data persists when users refresh their browser.

1. In Window 1:
   - Create several lines with people
   - Add people to wait queues
   - Configure some timers
2. Refresh the page (F5)
3. Wait for the page to reload

**Expected Result:** All data should reappear exactly as it was before the refresh.

### Test 8: Moving People Between Lines

**Goal:** Verify moving people from wait queue to active lines works correctly.

1. In Window 1:
   - Create Line A with max people
   - Add person "David" to wait queue
2. In Window 2:
   - Remove one person from Line A
   - Move "David" from wait queue to active line
3. In Window 1:
   - Verify "David" moved to active line
   - Verify wait queue is now empty

**Expected Result:** People movements should sync across all clients immediately.

## Performance Tests

### Latency Test

**Goal:** Measure sync latency between clients.

1. Open app in two windows side by side
2. Add a person in Window 1
3. Start a timer
4. Stop timer when the person appears in Window 2

**Expected Result:** Latency should be < 2 seconds (typically 200-500ms).

### Load Test (Stress Test)

**Goal:** Verify the app handles rapid changes.

1. Open app in one window
2. Rapidly add 20 people to a line (as fast as you can click)
3. Open in another window
4. Verify all 20 people appear correctly, in order, with no duplicates

**Expected Result:** All changes should sync correctly without data loss.

## Common Issues and Solutions

### Issue: Changes not syncing

**Check:**
- Browser console for Firebase errors
- Firebase Console → Database → Data tab to see if data is being written
- Network tab to verify Firebase requests are succeeding
- Verify Firebase config is correct (especially `databaseURL`)

### Issue: "Permission denied" error

**Check:**
- Firebase Console → Database → Rules
- Verify rules allow read/write access
- Click "Publish" after updating rules

### Issue: Duplicate data

**Check:**
- Look for JavaScript errors in console
- Verify you're not running the old version and new version simultaneously
- Clear browser cache and try again

### Issue: Slow sync (> 5 seconds)

**Check:**
- Your internet connection speed
- Firebase database region (should be close to your location)
- Browser console for errors

## Success Criteria

All tests should pass with these results:
- ✅ Changes sync in < 2 seconds
- ✅ No data loss during concurrent modifications
- ✅ Per-line wait queues persist correctly
- ✅ No conflicts or overwrites
- ✅ Handles reconnection gracefully
- ✅ Data persists through page refreshes

## Comparing to Old System

If you want to verify improvements over the old Socket.IO system:

**Old Issues (should now be fixed):**
- ❌ Per-line wait queues were lost on refresh
- ❌ Concurrent updates could be dropped
- ❌ "State update in progress" would skip incoming changes
- ❌ Conflicts required manual refresh
- ❌ Duplicate saves to database

**New Firebase System:**
- ✅ All data persists including wait queues
- ✅ No dropped updates
- ✅ No blocking flags
- ✅ Automatic conflict resolution
- ✅ Single source of truth

## Next Steps After Testing

If all tests pass:
1. Mark testing complete ✅
2. Deploy to production GitHub Pages
3. Delete Fly.io backend (see instructions below)
4. Monitor first live event closely

## Deleting Old Infrastructure

After successful testing and deployment:

1. **Delete Fly.io App:**
   ```bash
   fly apps destroy speed-chat-api
   ```

2. **Delete PostgreSQL Database:**
   - Already included in app deletion above

3. **Remove backend code:**
   ```bash
   git rm -r backend/
   git commit -m "Remove backend after migrating to Firebase"
   git push
   ```

4. **Update README:**
   - Remove references to backend
   - Add note about Firebase

You should see immediate cost savings as Firebase is free for your usage.
