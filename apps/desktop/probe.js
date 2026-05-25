const e = require('electron');
console.log('typeof electron:', typeof e);
console.log('electron keys:', Object.keys(e || {}));
console.log('electron.app:', e && e.app);
process.exit(0);
