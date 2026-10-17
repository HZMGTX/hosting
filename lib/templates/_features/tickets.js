const {
  SlashCommandBuilder, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  InteractionContextType, MessageFlags
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('ticket').setDescription('Open a private support ticket')
    .addStringOption(o => o.setName('topic').setDescription('What do you need help with?'))
    .setContexts(InteractionContextType.Guild),
  buttons: 'ticket:',
  async execute(interaction) {
    const guild = interaction.guild;
    const name = `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
    const existing = guild.channels.cache.find(c => c.name === name);
    if (existing) return interaction.reply({ content: `You already have an open ticket: ${existing}`, flags: MessageFlags.Ephemeral });

    const staffRole = process.env.TICKET_STAFF_ROLE_ID;
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
    ];
    if (staffRole) overwrites.push({ id: staffRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });

    const channel = await guild.channels.create({ name, type: ChannelType.GuildText, permissionOverwrites: overwrites });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger)
    );
    const topic = interaction.options.getString('topic') || 'No topic given';
    await channel.send({ content: `🎫 ${interaction.user} opened a ticket.\n**Topic:** ${topic}${staffRole ? `\n<@&${staffRole}>` : ''}`, components: [row] });
    await interaction.reply({ content: `✅ Ticket created: ${channel}`, flags: MessageFlags.Ephemeral });
  },
  async onButton(interaction) {
    if (interaction.customId !== 'ticket:close') return;
    await interaction.reply('🔒 Closing this ticket in 5 seconds…');
    setTimeout(() => interaction.channel.delete('Ticket closed').catch(() => {}), 5000);
  }
};
