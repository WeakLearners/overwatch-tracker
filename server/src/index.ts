import dotenv from 'dotenv';
import path from 'path';
// Load server/.env explicitly (relative to this file) so the key is found no
// matter the launch cwd — `dotenv/config` only reads from process.cwd().
dotenv.config({ path: path.resolve(__dirname, '../.env') });
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
