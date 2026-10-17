// Express app hosted on OmniHost. OmniHost sets PORT for you — always listen on it.
const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const started = Date.now();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Keep URLs relative (e.g. fetch('api/hello')) so the app works both at /apps/<id>/ and on a custom domain.
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from OmniHost!', uptimeSeconds: Math.round((Date.now() - started) / 1000) });
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(port, () => console.log(`Web app listening on port ${port}`));
