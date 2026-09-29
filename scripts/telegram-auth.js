require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
    console.error('Error: Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env');
    process.exit(1);
}

const stringSession = new StringSession(''); // Empty string for a new session

(async () => {
    console.log('Starting Telegram Authentication...');
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    
    await client.start({
        phoneNumber: async () => await askQuestion('Please enter your phone number (e.g. +1234567890): '),
        password: async () => await askQuestion('Please enter your 2FA password (if any): '),
        phoneCode: async () => await askQuestion('Please enter the code you received on Telegram: '),
        onError: (err) => console.log('Telegram Auth Error:', err),
    });
    
    console.log('\n--- Authentication Successful ---');
    console.log('Please copy the session string below and add it to your .env file as TELEGRAM_SESSION=...');
    console.log('\n' + client.session.save() + '\n');
    rl.close();
    process.exit(0);
})();
