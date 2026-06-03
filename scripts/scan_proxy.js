const http = require('http');

async function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ port, status: res.statusCode, data: data.trim() });
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function scan() {
  for (let port = 3010; port <= 3020; port++) {
    const res = await checkPort(port);
    if (res) {
      console.log(`Port ${port}: [${res.status}] ${res.data.substring(0, 50)}`);
    }
  }
}

scan();
