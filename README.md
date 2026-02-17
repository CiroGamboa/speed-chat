# Speed Chat

Real-time queue management system for Speed Chat events.

## Architecture

- **Frontend:** Static HTML/CSS/JavaScript hosted on GitHub Pages
- **Database:** Firebase Realtime Database (free tier)
- **Deployment:** GitHub Pages (free)

## Features

- Real-time synchronization across multiple devices
- Queue management with wait queues
- Timer system for session management
- Configuration management
- Zero cost (uses free tiers)

## Setup

1. Follow the instructions in `FIREBASE_SETUP.md` to create and configure your Firebase project
2. Update the Firebase configuration in `index.html` (around line 1360)
3. Deploy to GitHub Pages or serve locally

## Testing

See `TESTING_GUIDE.md` for comprehensive testing instructions before your first event.

## Usage

The app is designed for low-frequency, high-reliability use during events (1-2 times per month). Multiple users can simultaneously manage queues with real-time synchronization.

## Cost

- **Firebase:** Free tier (covers up to 100 concurrent users)
- **GitHub Pages:** Free
- **Total:** $0/month

## Migration Notes

This app was migrated from a Fly.io backend + PostgreSQL to Firebase Realtime Database to achieve:
- Zero cost (previously ~$5/month)
- Better real-time sync
- Simpler architecture
- Resolved sync issues (per-line wait queues, race conditions, conflicts)
