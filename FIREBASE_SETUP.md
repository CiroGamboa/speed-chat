# Firebase Setup Instructions

Follow these steps to set up Firebase for your Speed Chat application:

## 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project"
3. Enter project name: `speed-chat` (or your preferred name)
4. Disable Google Analytics (not needed for this app)
5. Click "Create project"

## 2. Enable Realtime Database

1. In the Firebase Console, go to "Build" → "Realtime Database"
2. Click "Create Database"
3. Choose location closest to your users (e.g., `us-central1`)
4. Start in **test mode** (we'll configure security rules next)
5. Click "Enable"

## 3. Configure Security Rules

1. In the Realtime Database page, go to the "Rules" tab
2. Replace the default rules with:

```json
{
  "rules": {
    "state": {
      ".read": true,
      ".write": true,
      ".validate": "newData.hasChildren(['timestamp', 'config'])"
    }
  }
}
```

3. Click "Publish"

**Note:** These rules allow anyone to read/write. For better security in production, consider adding authentication.

## 4. Get Firebase Configuration

1. Click the gear icon ⚙️ next to "Project Overview"
2. Select "Project settings"
3. Scroll down to "Your apps" section
4. Click the web icon `</>` to add a web app
5. Register app with nickname: "speed-chat-web"
6. Copy the `firebaseConfig` object that looks like:

```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

## 5. Update index.html

Open `index.html` and find the comment `// REPLACE WITH YOUR FIREBASE CONFIG` around line 1360.

Replace the placeholder config with your actual Firebase configuration from step 4.

## 6. Test the Setup

1. Save `index.html`
2. Open the file in your browser
3. Open browser console (F12)
4. You should see: "Firebase initialized successfully"
5. Make a change (add a line, add a person)
6. Check Firebase Console → Realtime Database → Data tab
7. You should see your data under `/state`

## 7. Test Multi-User Sync

1. Open the app in two different browser windows
2. Make changes in one window
3. Changes should appear in the other window within milliseconds

## Troubleshooting

**Error: "Firebase App named '[DEFAULT]' already exists"**
- You refreshed the page. This is harmless, the app will continue to work.

**Error: "Permission denied"**
- Check that security rules are published
- Verify the `databaseURL` in your config is correct

**Data not syncing**
- Open browser console and check for errors
- Verify you're using the correct `databaseURL`
- Make sure both windows are online

## Clean Up After Events

After each event, you can clear the data:

### Option 1: Firebase Console
1. Go to Realtime Database → Data
2. Hover over `/state` node
3. Click the "×" to delete
4. Confirm deletion

### Option 2: In-App (if you add a button)
```javascript
firebase.database().ref('state').remove();
```

## Free Tier Limits

Your app is well within free tier limits:
- **Storage:** 1 GB (your data is ~1 KB)
- **Bandwidth:** 10 GB/month (each event uses ~1 MB)
- **Connections:** 100 simultaneous (you need 2-5)

You should never hit any limits with your usage pattern.
