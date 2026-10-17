const { Events, ActivityType } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    client.user.setPresence({ activities: [{ name: '/ping', type: ActivityType.Listening }], status: 'online' });
  }
};
