const fs = require('fs');
const path = require('path');

fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
