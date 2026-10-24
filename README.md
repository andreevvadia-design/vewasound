# VewaSound

Minimalist dark-themed music streaming web application and Telegram Mini App with SoundCloud streaming proxy and cloud session sync.

## Overview

VewaSound is an ultra-fast, high-contrast music streaming player built without heavy frontend frameworks. It provides low-latency audio playback, live catalog search, artist profiles, album views, and seamless integration as a Telegram Web App.

## Features

- **Dark-Minimalist UI**: Custom high-contrast aesthetic with smooth micro-interactions, vinyl disk animations, and responsive layouts for desktop and mobile.
- **Audio Engine**: Full HLS streaming support via `hls.js`, persistent volume state, seekbar scrubbing, and background playback.
- **SoundCloud Integration**: Lightweight Node.js streaming proxy that resolves tracks and playlists with automatic client-id discovery and caching.
- **Telegram Mini App (TMA)**: Full Telegram WebApp SDK support with native full-screen expansion, theme adaptation, and zero-click account synchronization.
- **Library & Statistics**: Local listening statistics (total tracks, minutes played), custom profile photo uploads, and favorites playlist.

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- npm

### Installation & Run

1. Clone the repository:
   ```bash
   git clone https://github.com/andreevvadia-design/vewasound.git
   cd vewasound
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   ```bash
   npm start
   ```

4. Open `http://localhost:3000` in your browser.

## Deployment

The application is cloud-ready and can be deployed to any platform supporting Node.js (Render, Railway, Heroku, or VPS):

- **Build command**: `npm install`
- **Start command**: `npm start`
- **Environment variables**:
  - `PORT`: (optional, defaults to 3000)
  - `ADMIN_SECRET`: (optional, for administrative access)

## License

MIT License. Created by [andreevvadia-design](https://github.com/andreevvadia-design).
