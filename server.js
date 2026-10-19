require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is missing or too short (use 32+ random characters). See .env.example');
  process.exit(1);
}

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'upgrade-insecure-requests': null
    }
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/claims', require('./routes/claims'));
app.use('/api/history', require('./routes/history'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ message: 'Request too large. Use a smaller photo.' });
  if (err.name === 'ValidationError') return res.status(400).json({ message: 'Some fields are invalid.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ message: 'Bad request.' });
  console.error(err);
  res.status(500).json({ message: 'Server error. Please try again.' });
});

const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Back2You running → http://localhost:${PORT}`));
});
