const { getOrbitalStatus } = require('./src/infra/orbital-startup-orchestrator');

async function run() {
    const status = await getOrbitalStatus();
    console.log(JSON.stringify(status, null, 2));
}

run();
