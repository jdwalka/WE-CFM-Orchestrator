const { spawn } = require('child_process');
const fs = require('fs');

const logStream = fs.createWriteStream('g:/WECRYP/pyth-startup.log');

const child = spawn('npm', ['run', 'start:dev'], {
  cwd: 'g:/WECRYP',
  shell: true
});

child.stdout.on('data', data => {
  const str = data.toString();
  logStream.write(str);
  console.log(str.trim());
});

child.stderr.on('data', data => {
  const str = data.toString();
  logStream.write(str);
  console.error(str.trim());
});

setTimeout(() => {
  console.log('Test complete, killing app...');
  child.kill();
  process.exit(0);
}, 10000);
