const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const proxyPath = path.join(__dirname, 'proxy.js');

const proc = spawn(process.execPath, [proxyPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: __dirname,
});

proc.stdout.on('data', (d) => process.stdout.write(d));
proc.stderr.on('data', (d) => process.stderr.write(d));

function testEndpoint(url, label) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        console.log(`\n=== ${label} ===`);
        console.log(data);
        resolve();
      });
    }).on('error', (err) => {
      console.log(`\n=== ${label} ===`);
      console.log('Error:', err.message);
      resolve();
    });
  });
}

setTimeout(async () => {
  await testEndpoint('http://localhost:8080/health', '/health');
  await testEndpoint('http://localhost:8080/v1/models', '/v1/models');
  await testEndpoint('http://localhost:8080/api/stats', '/api/stats');
  await testEndpoint('http://localhost:8080/api/config', '/api/config');
  proc.kill();
  process.exit(0);
}, 2000);
