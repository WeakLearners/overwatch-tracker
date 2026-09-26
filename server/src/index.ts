import dotenv from 'dotenv';
import path from 'path';
// Load server/.env explicitly (relative to this file) so the key is found no
// matter the launch cwd — `dotenv/config` only reads from process.cwd().
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import matchesRouter from './routes/matches';
import statsRouter from './routes/stats';
import advisorRouter from './routes/advisor';
import aimRouter from './routes/aim';
import blindRouter from './routes/blind';
import customPhasesRouter from './routes/customPhases';
import ranksRouter from './routes/ranks';
import configRouter from './routes/config';
import dfRouter from './routes/df';

const app = express();
const PORT = 3001;

// Allowed origins come from ALLOWED_ORIGINS (comma-separated) so a tailnet IP
// doesn't have to live in source. Defaults to localhost only if unset.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.use('/api/matches', matchesRouter);
app.use('/api/ranks', ranksRouter);
app.use('/api/stats', statsRouter);
app.use('/api/advisor', advisorRouter);
app.use('/api/aim', aimRouter);
app.use('/api/blind', blindRouter);
app.use('/api/custom-phases', customPhasesRouter);
app.use('/api/config', configRouter);
app.use('/api/df', dfRouter);

// Serve the production client build (2026-09-26). `client/current` is a
// symlink, not a real directory — it points at whichever of client/dist-a or
// client/dist-b holds the latest successful build, and scripts/build-
// client.sh repoints it atomically after every commit (see that script's own
// comments for why a symlink swap rather than an in-place rewrite). Express
// resolves `clientDist` to an absolute path once, here, but `express.static`
// re-stats/re-reads through that path on every request, so a rebuild takes
// effect immediately with no restart of this process.
//
// This turns port 3001 into both the API and the "just use the app" address
// — no separate static file server, one less always-on process. Port 5173
// (the Vite dev server) is unaffected and stays the editing surface.
//
// Registered unconditionally, not gated on `fs.existsSync` at startup: this
// process can boot before the very first build has finished (or before one
// has ever run), and nothing here restarts it once a build lands later —
// tsx watch only reacts to server/src changes, not to client/current
// appearing. express.static already no-ops (calls next()) when its root is
// missing, so the only place that needs a per-request existence check is the
// SPA fallback below, which runs on every request anyway.
const clientDist = path.resolve(__dirname, '../../client/current');
app.use(express.static(clientDist));
// SPA fallback: any GET that isn't a static asset and isn't under /api
// (those are already handled above, so this never intercepts them) gets
// index.html, so React Router's client-side routes (/prematch, /log,
// /trends, /sens, /sens/analysis, /settings) work on a hard refresh or a
// bookmarked deep link, not just via in-app navigation.
app.get('*', (req, res) => {
  // A bad /api/* path reaching here (the real routers above didn't match
  // it) should 404 like an API, not silently serve the app shell.
  if (req.path.startsWith('/api')) { res.status(404).json({ error: 'Not found' }); return; }
  if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
    res.status(503).send('No production build yet — run scripts/build-client.sh, or use the dev server on :5173.');
    return;
  }
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
