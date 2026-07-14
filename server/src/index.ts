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

const app = express();
const PORT = 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

app.use('/api/matches', matchesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/advisor', advisorRouter);
app.use('/api/aim', aimRouter);
app.use('/api/blind', blindRouter);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
