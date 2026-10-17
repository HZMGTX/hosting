const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check latency'),
  async execute(interaction, client) {
    const sent = await interaction.reply({ content: 'Pinging…', withResponse: true });
    const roundTrip = sent.resource.message.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`🏓 Pong! Round trip: ${roundTrip}ms · Gateway: ${client.ws.ping}ms`);
  }
};
