require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { handleGuildCreate, handleMessage } = require('./commands');
const { initializeDatabase, Vouch } = require('./database');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

initializeDatabase().then(() => {
  client.login(process.env.TOKEN).catch(err => console.error('Login failed:', err.message));
}).catch(err => console.error('Database initialization failed:', err.message));

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));

client.on('guildCreate', guild => handleGuildCreate(guild, client, process.env.NOTIFICATION_CHANNEL_ID, process.env.THUMBNAIL_URL));

client.on('messageCreate', message => handleMessage(
  message,
  client,
  Vouch,
  process.env.ALLOWED_CHANNEL_IDS ? process.env.ALLOWED_CHANNEL_IDS.split(',') : [],
  process.env.OWNER_IDS ? process.env.OWNER_IDS.split(',') : [],
  process.env.NOTIFICATION_CHANNEL_ID,
  process.env.LOG_CHANNEL_ID,
  parseInt(process.env.VOUCH_COOLDOWN_SECONDS) || 86400,
  process.env.THUMBNAIL_URL
));

process.on('unhandledRejection', error => console.error('Uncaught Promise Rejection:', error.message));