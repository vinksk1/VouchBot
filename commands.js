require('dotenv').config();
const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField } = require('discord.js');
const { generateVouchId } = require('./utils');
const { v4: uuidv4 } = require('uuid');

const cooldowns = new Map();
const stickyMessages = new Map();

function generateGuid() {
  return uuidv4();
}

function validateThumbnailUrl(url) {
  if (!url) return null;
  try {
    new URL(url);
    return url.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? url : null;
  } catch {
    return null;
  }
}

function isOnCooldown(userId, command, cooldownTime = 2) {
  if (!cooldowns.has(command)) cooldowns.set(command, new Map());
  const now = Date.now();
  const timestamps = cooldowns.get(command);
  const cooldownAmount = cooldownTime * 1000;
  if (timestamps.has(userId)) {
    const expirationTime = timestamps.get(userId) + cooldownAmount;
    if (now < expirationTime) return Math.ceil((expirationTime - now) / 1000);
  }
  timestamps.set(userId, now);
  setTimeout(() => timestamps.delete(userId), cooldownAmount);
  return false;
}

function hasPermissions(channel, client, permissions) {
  if (!channel || !client.user) return false;
  const perms = channel.permissionsFor(client.user);
  return perms && perms.has(permissions);
}

async function safeSend(channel, content, client, thumbnailUrl) {
  if (!client?.user || !channel?.isTextBased()) return null;
  if (!hasPermissions(channel, client, [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) return null;
  try {
    const validatedThumbnail = validateThumbnailUrl(thumbnailUrl);
    return await channel.send(typeof content === 'string' ? 
      { embeds: [new EmbedBuilder().setDescription(content).setColor('#00FF00').setThumbnail(validatedThumbnail)] } : 
      { ...content, embeds: content.embeds?.map(embed => embed.setThumbnail(validatedThumbnail)) }
    );
  } catch (error) {
    console.error('SafeSend error:', error.message);
    return null;
  }
}

async function safeReply(message, content, client, thumbnailUrl) {
  if (!client?.user || !message?.channel) return null;
  if (!hasPermissions(message.channel, client, [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) return null;
  try {
    const validatedThumbnail = validateThumbnailUrl(thumbnailUrl);
    return await message.reply(typeof content === 'string' ? 
      { embeds: [new EmbedBuilder().setDescription(content).setColor('#00FF00').setThumbnail(validatedThumbnail)] } : 
      { ...content, embeds: content.embeds?.map(embed => embed.setThumbnail(validatedThumbnail)) }
    );
  } catch (error) {
    console.error('SafeReply error:', error.message);
    return await safeSend(message.channel, content, client, thumbnailUrl);
  }
}

async function setupPagination(message, embed, items, itemsPerPage, generateEmbed, client, thumbnailUrl) {
  const totalPages = Math.ceil(items.length / itemsPerPage);
  let currentPage = 1;
  if (totalPages <= 1) return await safeReply(message, { embeds: [embed.setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnailUrl);
  
  embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`).setThumbnail(validateThumbnailUrl(thumbnailUrl));
  const prevButton = new ButtonBuilder().setCustomId('prev_page').setLabel('Previous').setStyle(ButtonStyle.Primary).setDisabled(currentPage === 1);
  const nextButton = new ButtonBuilder().setCustomId('next_page').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(currentPage === totalPages);
  const row = new ActionRowBuilder().addComponents(prevButton, nextButton);
  const reply = await safeReply(message, { embeds: [embed], components: [row] }, client, thumbnailUrl);
  if (!reply) return;

  const filter = i => ['prev_page', 'next_page'].includes(i.customId) && !i.user.bot && i.user.id === message.author.id;
  const collector = reply.createMessageComponentCollector({ filter, time: 120000 });
  
  collector.on('collect', async interaction => {
    if (interaction.customId === 'next_page' && currentPage < totalPages) currentPage++;
    else if (interaction.customId === 'prev_page' && currentPage > 1) currentPage--;
    else return;
    
    const newEmbed = await generateEmbed(items, currentPage, totalPages);
    const updatedPrevButton = ButtonBuilder.from(prevButton).setDisabled(currentPage === 1);
    const updatedNextButton = ButtonBuilder.from(nextButton).setDisabled(currentPage === totalPages);
    const updatedRow = new ActionRowBuilder().addComponents(updatedPrevButton, updatedNextButton);
    await interaction.update({ embeds: [newEmbed.setThumbnail(validateThumbnailUrl(thumbnailUrl))], components: [updatedRow] });
  });

  collector.on('end', async () => {
    if (reply.editable) {
      const disabledRow = new ActionRowBuilder().addComponents(
        ButtonBuilder.from(prevButton).setDisabled(true),
        ButtonBuilder.from(nextButton).setDisabled(true)
      );
      await reply.edit({ components: [disabledRow], embeds: [embed.setDescription(embed.description + '\n*Interaction timed out*').setThumbnail(validateThumbnailUrl(thumbnailUrl))] });
    }
  });
}

async function handleGuildCreate(guild, client, notificationChannelId, thumbnailUrl) {
  if (!client?.user || !guild) return null;
  let inviteLink = 'No invite link generated';
  try {
    const channel = guild.channels.cache.find(c => c.isTextBased() && hasPermissions(c, client, PermissionsBitField.Flags.CreateInstantInvite));
    if (channel) inviteLink = (await channel.createInvite({ maxAge: 86400, maxUses: 1 })).url;
  } catch (error) {
    console.error(`Invite error:`, error.message);
  }
  return new EmbedBuilder()
    .setTitle('Guild Joined')
    .setDescription(`Joined ${guild.name} (${guild.id}) with ${guild.memberCount} members. Invite: ${inviteLink}`)
    .setColor('#00FF00')
    .setThumbnail(validateThumbnailUrl(thumbnailUrl))
    .setTimestamp();
}

async function updateStickyMessage(channel, client, thumbnailUrl) {
  if (!channel?.isTextBased() || !hasPermissions(channel, client, [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageMessages])) return;

  const previousStickyId = stickyMessages.get(channel.id);
  if (previousStickyId) {
    try {
      const previousMessage = await channel.messages.fetch(previousStickyId).catch(() => null);
      if (previousMessage) await previousMessage.delete();
    } catch (error) {
      console.error('Error deleting previous sticky message:', error.message);
    }
  }

  const stickyEmbed = new EmbedBuilder()
    .setTitle('📜 Vouch Guide')
    .setDescription(
      'To vouch for someone, use this format:\n' +
      '`!vouch @user [message]` (Proof/Screenshot Required)\n' +
      '- `@user`: Mention the user you\'re vouching for\n' +
      '- `[message]`: Optional comment (max 500 chars)\n' +
      '- Attach a screenshot/proof\n' +
      'Example: `!vouch @Koala Trusted gwapo sarap kalami.` (with screenshot)'
    )
    .setColor('#0099FF')
    .setFooter({ text: 'Koala Vouch Bot' })
    .setThumbnail(validateThumbnailUrl(thumbnailUrl));

  try {
    const stickyMessage = await safeSend(channel, { embeds: [stickyEmbed] }, client, thumbnailUrl);
    if (stickyMessage) {
      stickyMessages.set(channel.id, stickyMessage.id);
    }
  } catch (error) {
    console.error('Error posting sticky message:', error.message);
  }
}

async function handleMessage(message, client, Vouch, allowedChannelIds, ownerIds, notificationChannelId, logChannelId, vouchCooldownSeconds, thumbnailUrl) {
  if (message.author.bot) return;

  const commands = ['vouch', 'vouchgive', 'vouches', 'vouchhistory', 'vouchremove', 'vouchstats', 'vouchleaderboard', 'vouchsearch', 'vouchtransfer', 'restorevouches', 'help', 'koala'];
  let command = message.content.toLowerCase().trim();
  if (command.startsWith('!')) command = command.slice(1).split(/\s+/)[0];
  else command = commands.find(cmd => command === cmd || command.startsWith(`${cmd} `)) || '';
  let args = command ? message.content.slice(command.length + (message.content.startsWith('!') ? 1 : 0)).trim().split(/\s+/) : [];

  if (allowedChannelIds.includes(message.channel.id)) {
    await updateStickyMessage(message.channel, client, thumbnailUrl);
  }

  if (!commands.includes(command)) return;
  if (!allowedChannelIds.includes(message.channel.id) && !ownerIds.includes(message.author.id)) return;

  const cooldown = isOnCooldown(message.author.id, command);
  if (cooldown) {
    return await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle('Cooldown')
          .setDescription(`Please wait ${cooldown} seconds before using this command again.`)
          .setColor('#FF0000')
          .setTimestamp()
          .setThumbnail(validateThumbnailUrl(thumbnailUrl))
      ]
    }, client, thumbnailUrl);
  }

  const thumbnail = validateThumbnailUrl(thumbnailUrl) || 'https://media.discordapp.net/attachments/1205060939284742175/1386627897636421854/E20FEA31-D28A-4370-B06B-BFABD8ACE473.gif?ex=685a655d&is=685913dd&hm=75b63af509452e259c4f64f25af6f90ce1b26059e80c54575f948275df7170a3&=';

  if (command === 'koala') {
    const koalaEmbed = new EmbedBuilder()
      .setTitle('Koala Bot')
      .setDescription('The most kupal bot on Discord!')
      .addFields(
        { name: 'Commands', value: 'Use `!help` to see all commands', inline: true },
        { name: 'Owner', value: '<@1139540844853084172>', inline: true },
        { name: 'Version', value: '2.0.0', inline: true }
      )
      .setImage(thumbnail)
      .setColor('#00AA00')
      .setFooter({ text: 'Bawal kupal dito.' })
      .setThumbnail(validateThumbnailUrl(thumbnailUrl));
    return await safeReply(message, { embeds: [koalaEmbed] }, client, thumbnail);
  }

  if (command === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('Koala Bot Help')
      .setDescription('Here are all available commands:')
      .addFields(
        {
          name: 'Vouch Commands',
          value: '```' +
            '!vouch <@user|userID> [message] - Give someone a vouch\n' +
            '!vouches [@user|userID] - Check someone\'s vouches\n' +
            '!vouchhistory <@user|userID> - See full vouch history\n' +
            '!vouchleaderboard - Top vouched users\n' +
            '```'
        },
        {
          name: 'Admin Commands',
          value: '```' +
            '!vouchgive <@user|userID> count message - Give multiple vouches\n' +
            '!vouchremove <@user|userID> - Remove vouches\n' +
            '!vouchtransfer <@from> <@to> - Transfer vouches\n' +
            '!restorevouches - Restore vouches from user\n' +
            '```'
        },
        {
          name: 'Other',
          value: '```' +
            '!koala - Show bot owner\n' +
            '!help - Display this help message\n' +
            '```'
        }
      )
      .setColor('#0099FF')
      .setFooter({ text: 'Need more help? Contact the bot owner' })
      .setThumbnail(validateThumbnailUrl(thumbnailUrl));
    return await safeReply(message, { embeds: [helpEmbed] }, client, thumbnail);
  }

  if (command === 'vouch') {
    if (args.length < 1 && !message.mentions.users.first()) {
      const embed = new EmbedBuilder()
        .setTitle('Vouch Command Guide')
        .setDescription(
          `How to use !vouch:\n- Syntax: !vouch <@user|userID> [message]\n- <@user|userID>: Mention or ID of user\n- [message]: Optional comment (max 500 chars)\n- Attach a screenshot/proof\nExample: !vouch @Koala Trusted gwapo sarap kalami.\n\nMessage ID: \`${generateGuid()}\``
        )
        .setColor('#FFFF00')
        .setThumbnail(validateThumbnailUrl(thumbnailUrl));
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      await message.react('❌');
      return;
    }

    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
      args.shift();
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]).catch(() => null);
        if (!user) {
          await safeReply(message, {
            embeds: [
              new EmbedBuilder()
                .setTitle('Error')
                .setDescription(`Invalid user ID: \`${args[0]}\`. Please provide a valid user mention or ID.`)
                .setColor('#FF0000')
                .setThumbnail(validateThumbnailUrl(thumbnailUrl))
            ]
          }, client, thumbnail);
          await message.react('❌');
          return;
        }
        args.shift();
      } catch (error) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle('Error')
              .setDescription(`Invalid user ID. Please provide a valid user mention or ID.`)
              .setColor('#FF0000')
              .setThumbnail(validateThumbnailUrl(thumbnailUrl))
          ]
        }, client, thumbnail);
        await message.react('❌');
        return;
      }
    } else {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`Invalid user input. Please provide a user mention (e.g., @user) or a valid user ID as the first argument.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
      await message.react('❌');
      return;
    }

    if (user.id === message.author.id) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`You can't vouch for yourself.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
      await message.react('❌');
      return;
    }

    const vouchMessage = args.join(' ').substring(0, 500) || 'No comment provided';

    const attachment = message.attachments.first();
    if (!attachment) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`No proof/screenshot attached. Please provide a screenshot to verify the vouch's authenticity.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
      await message.react('❌');
      return;
    }

    if (!ownerIds.includes(message.author.id)) {
      const lastVouch = await Vouch.findOne({ userId: user.id, vouchedBy: message.author.id, deleted: false }).sort({ timestamp: -1 });
      if (lastVouch) {
        const timeSinceLastVouch = (Date.now() - lastVouch.timestamp) / 1000;
        if (timeSinceLastVouch < vouchCooldownSeconds) {
          const remainingSeconds = Math.ceil(vouchCooldownSeconds - timeSinceLastVouch);
          const minutes = Math.floor(remainingSeconds / 60);
          const seconds = remainingSeconds % 60;
          await safeReply(message, {
            embeds: [
              new EmbedBuilder()
                .setTitle('Cooldown Error')
                .setDescription(`Wait ${minutes}m ${seconds}s before vouching for this user again.`)
                .setColor('#FF0000')
                .setThumbnail(validateThumbnailUrl(thumbnailUrl))
            ]
          }, client, thumbnail);
          await message.react('❌');
          return;
        }
      }
    }

    try {
      const newVouch = new Vouch({
        userId: user.id,
        vouchedBy: message.author.id,
        points: 1,
        message: vouchMessage,
      });
      await newVouch.save();

      const count = await Vouch.countDocuments({ userId: user.id, deleted: false });

      const embed = new EmbedBuilder()
        .setTitle('Vouch Logged')
        .setDescription(`Vouch for ${user.tag} by ${message.author.tag}`)
        .addFields(
          { name: 'Vouches', value: `+1 Vouch`, inline: true },
          { name: 'Comment', value: vouchMessage, inline: false },
          { name: 'Vouch ID', value: `\`${newVouch.vouchId}\``, inline: true }
        )
        .setColor('#00FF00')
        .setFooter({ text: 'Thank you for using Koala Vouch Bot!' })
        .setThumbnail(validateThumbnailUrl(thumbnailUrl));

      await safeReply(message, { embeds: [embed] }, client, thumbnail);

      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        await safeSend(logChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle('Vouch Logged')
              .setDescription(`Vouch for ${user.tag} by ${message.author.tag}\nVouches: +1\nComment: ${vouchMessage}\nVouch ID: \`${newVouch.vouchId}\``)
              .setImage(attachment.url)
              .setColor('#00FF00')
              .setThumbnail(validateThumbnailUrl(thumbnailUrl))
          ]
        }, client, thumbnail);
      }
      await message.react('✅');
    } catch (error) {
      console.error('Vouch error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
      await message.react('❌');
    }
    return;
  }

  if (command === 'vouchgive') {
    if (!ownerIds.includes(message.author.id)) {
      return await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Permission Error')
            .setDescription(`Only bot owners can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }

    if (args.length < 3) {
      return await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Usage Error')
            .setDescription(`Usage: !vouchgive <@user|userID> count message`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }

    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
      args.shift();
    } else if (!isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]);
        args.shift();
      } catch {
        return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Invalid user ID.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
      }
    } else {
      return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Please mention a user or provide a valid user ID.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
    }

    const vouchCount = parseInt(args[0]);
    if (isNaN(vouchCount) || vouchCount < 1 || vouchCount > 1000) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Vouch count must be 1-1000.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

    const vouchMessage = args.slice(1).join(' ').substring(0, 500);
    if (!vouchMessage) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Message must be under 500 characters.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

    try {
      const timestamp = new Date();
      const vouches = Array(vouchCount).fill().map(() => ({
        userId: user.id,
        vouchedBy: message.author.id,
        points: 1,
        message: vouchMessage,
        timestamp: timestamp,
        vouchId: generateVouchId()
      }));

      await Vouch.insertMany(vouches);

      const count = await Vouch.countDocuments({ userId: user.id, deleted: false });

      const embed = new EmbedBuilder()
        .setTitle('Vouches Added')
        .setDescription(`Added ${vouchCount} vouches at <t:${Math.floor(Date.now() / 1000)}:f>`)
        .addFields(
          { name: 'User', value: user.tag, inline: true },
          { name: 'Vouches', value: `+${vouchCount}`, inline: true },
          { name: 'Total Vouches', value: `${count}`, inline: true },
          { name: 'Comment', value: vouchMessage, inline: false }
        )
        .setColor('#00FF00')
        .setFooter({ text: 'Thank you for using Koala Vouch Bot!' })
        .setThumbnail(validateThumbnailUrl(thumbnailUrl));
      
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      
      const channel = await client.channels.fetch(notificationChannelId).catch(() => null);
      if (channel) {
        await safeSend(channel, {
          embeds: [
            new EmbedBuilder()
              .setTitle('Vouches Added')
              .setDescription(`Added ${vouchCount} vouches for ${user.tag} by ${message.author.tag}`)
              .setColor('#00FF00')
              .setThumbnail(validateThumbnailUrl(thumbnailUrl))
          ]
        }, client, thumbnail);
      }
    } catch (error) {
      console.error('Vouchgive error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }

  if (command === 'vouches') {
    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]);
      } catch {
        return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Invalid user ID.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
      }
    } else {
      user = message.author;
    }

    try {
      const vouches = await Vouch.find({ userId: user.id, deleted: false }).sort({ timestamp: -1 });
      if (vouches.length === 0) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('No Vouches').setDescription(`${user.tag} has no vouches.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const count = await Vouch.countDocuments({ userId: user.id, deleted: false });
      const latestVouch = vouches[0];

      const embed = new EmbedBuilder()
        .setTitle('Vouch Summary')
        .setDescription(`Vouch details for ${user.tag}`)
        .addFields(
          { name: 'Vouches', value: `${count}`, inline: true },
          { name: 'Last Vouch', value: `<t:${Math.floor(latestVouch.timestamp.getTime() / 1000)}:R>`, inline: true },
          { name: 'Last Comment', value: `${latestVouch.message.substring(0, 50)}${latestVouch.message.length > 50 ? '...' : ''}`, inline: true }
        )
        .setColor('#00FF00')
        .setFooter({ text: `For full history, try !vouchhistory @${user.username}` })
        .setThumbnail(validateThumbnailUrl(thumbnailUrl));
      
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
    } catch (error) {
      console.error('Vouches error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }

  if (command === 'vouchhistory') {
    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]);
      } catch {
        return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Invalid user ID.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
      }
    } else {
      return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Usage Error').setDescription(`Usage: !vouchhistory <@user|userID> [page]`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
    }

    try {
      const vouches = await Vouch.find({ userId: user.id, deleted: false }).sort({ timestamp: -1 });
      if (vouches.length === 0) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('No Vouches').setDescription(`${user.tag} has no vouch history.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const page = parseInt(args[1]) || 1;
      if (page < 1) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Page number must be 1 or greater.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const itemsPerPage = 5;
      const totalPages = Math.ceil(vouches.length / itemsPerPage);
      if (page > totalPages) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Page must be 1-${totalPages}.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const generateEmbed = async (items, currentPage, totalPages) => {
        const start = (currentPage - 1) * itemsPerPage;
        const embed = new EmbedBuilder()
          .setTitle('Vouch History')
          .setDescription(`History for ${user.tag}`)
          .setColor('#00FF00')
          .setThumbnail(validateThumbnailUrl(thumbnailUrl));
        
        for (let i = start; i < Math.min(start + itemsPerPage, items.length); i++) {
          const vouch = items[i];
          embed.addFields(
            { name: `${i + 1}. By`, value: `<@${vouch.vouchedBy}> on <t:${Math.floor(vouch.timestamp.getTime() / 1000)}:f>`, inline: false },
            { name: 'Vouches', value: `+1`, inline: true },
            { name: 'Message', value: vouch.message || 'No message', inline: false }
          );
        }
        return embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`);
      };

      await setupPagination(message, await generateEmbed(vouches, page, totalPages), vouches, itemsPerPage, generateEmbed, client, thumbnail);
    } catch (error) {
      console.error('Vouchhistory error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }

  if (command === 'vouchremove') {
    if (!ownerIds.includes(message.author.id)) {
      return await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Permission Error')
            .setDescription(`Only bot owners can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }

    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]);
      } catch {
        return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Invalid user ID.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
      }
    } else {
      return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Usage Error').setDescription(`Usage: !vouchremove <@user|userID>`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
    }

    try {
      const result = await Vouch.updateMany(
        { userId: user.id, deleted: false },
        { $set: { deleted: true } }
      );

      if (result.modifiedCount === 0) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('No Vouches').setDescription(`${user.tag} has no vouches to remove.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const embed = new EmbedBuilder()
        .setTitle('Vouch Removal')
        .setDescription(`Removed ${result.modifiedCount} vouches for ${user.tag}.`)
        .setColor('#00FF00')
        .setThumbnail(validateThumbnailUrl(thumbnailUrl));
      
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      
      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        await safeSend(logChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle('Vouches Removed')
              .setDescription(`${message.author.tag} removed ${result.modifiedCount} vouches for ${user.tag}`)
              .setColor('#FF0000')
              .setThumbnail(validateThumbnailUrl(thumbnailUrl))
          ]
        }, client, thumbnail);
      }
    } catch (error) {
      console.error('Vouchremove error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }

  if (command === 'vouchstats') {
    try {
      const totalVouches = await Vouch.countDocuments({ deleted: false });
      const topGiver = await Vouch.aggregate([
        { $match: { deleted: false } },
        { $group: { _id: "$vouchedBy", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]);

      const topReceiver = await Vouch.aggregate([
        { $match: { deleted: false } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]);

      const embed = new EmbedBuilder()
        .setTitle('Vouch Statistics')
        .setDescription(`System statistics`)
        .setColor('#00FF00')
        .addFields(
          { name: 'Total Vouches', value: `${totalVouches}`, inline: true }
        )
        .setThumbnail(validateThumbnailUrl(thumbnailUrl));

      if (topGiver.length > 0) {
        const giver = await client.users.fetch(topGiver[0]._id).catch(() => ({ tag: 'Unknown User' }));
        embed.addFields({ name: 'Top Vouch Giver', value: `${giver.tag} (${topGiver[0].count} vouches)`, inline: true });
      }

      if (topReceiver.length > 0) {
        const receiver = await client.users.fetch(topReceiver[0]._id).catch(() => ({ tag: 'Unknown User' }));
        embed.addFields({ name: 'Most Vouched User', value: `${receiver.tag} (${topReceiver[0].count} vouches)`, inline: true });
      }

      await safeReply(message, { embeds: [embed] }, client, thumbnail);
    } catch (error) {
      console.error('Vouchstats error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }

  if (command === 'vouchleaderboard') {
    try {
      const topUsers = await Vouch.aggregate([
        { $match: { deleted: false } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 50 }
      ]);

      if (topUsers.length === 0) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('No Data').setDescription(`No vouches found.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const page = parseInt(args[0]) || 1;
      if (page < 1) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Page number must be 1 or greater.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const itemsPerPage = 10;
      const totalPages = Math.ceil(topUsers.length / itemsPerPage);
      if (page > totalPages) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Page must be 1-${totalPages}.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const generateEmbed = async (users, currentPage, totalPages) => {
        const start = (currentPage - 1) * itemsPerPage;
        const embed = new EmbedBuilder()
          .setTitle('Vouch Leaderboard')
          .setDescription(`Top vouched users`)
          .setColor('#00FF00')
          .setThumbnail(validateThumbnailUrl(thumbnailUrl));
        
        for (let i = start; i < Math.min(start + itemsPerPage, users.length); i++) {
          const user = await client.users.fetch(users[i]._id).catch(() => ({ tag: 'Unknown User' }));
          embed.addFields({ name: `${i + 1}.`, value: `${user.tag} - ${users[i].count} vouches`, inline: false });
        }
        return embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`);
      };

      await setupPagination(message, await generateEmbed(topUsers, page, totalPages), topUsers, itemsPerPage, generateEmbed, client, thumbnail);
    } catch (error) {
      console.error('Vouchleaderboard error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }

  if (command === 'vouchsearch') {
    if (!ownerIds.includes(message.author.id)) {
      return await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Permission Error')
            .setDescription(`Only bot owners can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }

    let user = message.mentions.users.first();
    let keyword = args.join(' ');
    let page = 1;
    
    if (user) keyword = args.slice(1).join(' ');
    if (!isNaN(parseInt(args[args.length - 1]))) {
      page = parseInt(args[args.length - 1]);
      keyword = user ? args.slice(1, -1).join(' ') : args.slice(0, -1).join(' ');
    }

    if (!keyword) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Usage Error').setDescription(`Usage: !vouchsearch [@user] keyword [page]`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);
    if (page < 1) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Page number must be 1 or greater.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

    try {
      const query = user 
        ? { userId: user.id, message: { $regex: keyword, $options: 'i' }, deleted: false } 
        : { message: { $regex: keyword, $options: 'i' }, deleted: false };

      const vouches = await Vouch.find(query).sort({ timestamp: -1 });
      if (vouches.length === 0) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('No Results').setDescription(`No vouches found for "${keyword}"${user ? ` for ${user.tag}` : ''}.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const itemsPerPage = 5;
      const totalPages = Math.ceil(vouches.length / itemsPerPage);
      if (page > totalPages) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Page must be 1-${totalPages}.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const generateEmbed = async (items, currentPage, totalPages) => {
        const start = (currentPage - 1) * itemsPerPage;
        const embed = new EmbedBuilder()
          .setTitle('Vouch Search Results')
          .setDescription(`Search results${user ? ` for ${user.tag}` : ''}\nSearch: \`${keyword}\``)
          .setColor('#00FF00')
          .setThumbnail(validateThumbnailUrl(thumbnailUrl));
        
        for (let i = start; i < Math.min(start + itemsPerPage, items.length); i++) {
          const vouch = items[i];
          const voucher = await client.users.fetch(vouch.vouchedBy).catch(() => ({ tag: 'Unknown User' }));
          const vouchedUser = await client.users.fetch(vouch.userId).catch(() => ({ tag: 'Unknown User' }));
          embed.addFields(
            { name: `${i + 1}.`, value: `For ${vouchedUser.tag} by ${voucher.tag}`, inline: false },
            { name: 'Vouches', value: `+1`, inline: true },
            { name: 'Message', value: vouch.message || 'No message', inline: false },
            { name: 'Date', value: `<t:${Math.floor(vouch.timestamp.getTime() / 1000)}:f>`, inline: false }
          );
        }
        return embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`);
      };

      await setupPagination(message, await generateEmbed(vouches, page, totalPages), vouches, itemsPerPage, generateEmbed, client, thumbnail);
    } catch (error) {
      console.error('Vouchsearch error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }

  if (command === 'vouchtransfer') {
    if (!ownerIds.includes(message.author.id)) {
      return await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Permission Error')
            .setDescription(`Only authorized users can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }

    if (message.mentions.users.size < 2) {
      return await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Usage Error')
            .setDescription(`Usage: !vouchtransfer <@sourceUser> <@targetUser>`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }

    const sourceUser = message.mentions.users.first();
    const targetUser = message.mentions.users.at(1);
    if (sourceUser.id === targetUser.id) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('Error').setDescription(`Source and target users must be different.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

    try {
      const count = await Vouch.countDocuments({ userId: sourceUser.id, deleted: false });
      if (count === 0) return await safeReply(message, { embeds: [new EmbedBuilder().setTitle('No Vouches').setDescription(`${sourceUser.tag} has no vouches to transfer.`).setColor('#FF0000').setThumbnail(validateThumbnailUrl(thumbnailUrl))] }, client, thumbnail);

      const result = await Vouch.updateMany(
        { userId: sourceUser.id, deleted: false },
        { $set: { userId: targetUser.id } }
      );

      const embed = new EmbedBuilder()
        .setTitle('Vouch Transfer')
        .setDescription(`Transferred ${result.modifiedCount} vouches from ${sourceUser.tag} to ${targetUser.tag}.`)
        .setColor('#00FF00')
        .setThumbnail(validateThumbnailUrl(thumbnailUrl));
      
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      
      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        await safeSend(logChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle('Vouch Transferred')
              .setDescription(`${message.author.tag} transferred ${result.modifiedCount} vouches from ${sourceUser.tag} to ${targetUser.tag}`)
              .setColor('#FF0000')
              .setThumbnail(validateThumbnailUrl(thumbnailUrl))
          ]
        }, client, thumbnail);
      }

      const notifyChannel = await client.channels.fetch(notificationChannelId).catch(() => null);
      if (notifyChannel) {
        await safeSend(notifyChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle('Vouch Transfer Notification')
              .setDescription(`Vouches transferred from ${sourceUser.tag} to ${targetUser.tag}`)
              .setColor('#00FF00')
              .setThumbnail(validateThumbnailUrl(thumbnailUrl))
          ]
        }, client, thumbnail);
      }
    } catch (error) {
      console.error('Vouchtransfer error:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle('Error')
            .setDescription(`An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(validateThumbnailUrl(thumbnailUrl))
        ]
      }, client, thumbnail);
    }
    return;
  }
}

module.exports = { 
  safeSend, 
  safeReply, 
  setupPagination, 
  handleGuildCreate, 
  handleMessage 
};