require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials, Events, ChannelType, MessageType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, AttachmentBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, REST, Routes, MessageFlags } = require('discord.js');
const mediadorProfile = require('./mediador-profile');
const teladorProfile = require('./telador-profile');
const analistaProfile = require('./analista-profile');
const { deferModalReply, respondToInteraction } = require('./interaction-response');
const { buildFilaStatusAnnouncement } = require('./queue-announcements');
const { canCloseTicket, canConfigurePix, canJoinMediatorQueue } = require('./access-control');
const { getQueueThreadName, parseQueueThreadName, getAllowedAuxThreadNames } = require('./queue-thread-names');
const { allocateQueueNumber } = require('./queue-numbering');
const { findQueueChannelConfigurations } = require('./queue-channel-names');
const { isQueueAnnouncementMessage } = require('./queue-messages');
const { formatQueueEmoji, getQueueEmoji } = require('./queue-emojis');
const {
  LOG_CHANNEL_DEFINITIONS,
  loadLogChannelOverrides,
  resolveLogChannels,
  saveLogChannelOverrides
} = require('./log-channels');
const { buildLogConfigPanel } = require('./log-config-panel');
const { removeQueuePlayers, updateQueueEmbedPlayers } = require('./queue-embed');
const { buildQueueRulesEmbed } = require('./queue-rules');
const { hasRecordedBetResult } = require('./bet-results');
const { buildArchivedQueueLogEntries } = require('./queue-log-entries');
const {
  buildMediadorSessionLogDetails,
  formatMediadorSessionTimestamp
} = require('./mediador-session-log');
const { getQueueImage, isQueueImageUrl, applyQueueImageToEmbed } = require('./queue-image');
const { DEFAULT_BET_VALUES, parseBetValuesInput, sortBetValuesDescending } = require('./queue-values');
const { getQueueCapacity } = require('./queue-capacity');
const { buildQueueParticipants } = require('./queue-participants');
const { buildQueueTranscriptHtml } = require('./queue-transcript');
const {
  buildLogEntrySelectPanel,
  buildUserLogsHome,
  buildUserQueueCategoryPanel,
  formatTicketLogText
} = require('./user-logs-panel');
const {
  createTicketThreadName,
  createTicketResolvingName,
  getTicketOwnerFromAnnouncement,
  getTicketOwnerFromThreadName,
  normalizeTicketName,
  setTicketAssigneeTopic
} = require('./ticket-utils');
const {
  TICKET_TYPES,
  buildTicketPanelEmbed,
  buildTicketOptionsRow,
  findTicketParentChannel,
  getTicketChannelEnvKey,
  getTicketChannelName,
  getTicketStaffRoleIds,
  getTicketTypeFromChannelName,
  getTicketTypeLabel,
  resolveTicketParentChannel
} = require('./ticket-options');
const { handleMeetCommand } = require('./meet');
const { getWinRatePercentage } = require('./profile-stats');
const QRCode = require('qrcode');
const { buildPixPayload, containsPixKeyInText, findPixKeyInText, normalizePixKey } = require('./pix-qrcode');
const { createGuildMembersCache } = require('./guild-members-cache');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const activeTickets = new Map();
const ticketOpeningPromises = new Map();
const auxSelections = new Map();
const queueLogSelections = new Map();
const userLogQuerySelections = new Map();
const mediadorControlQueue = [];
const mediadorQueueRoleId = '1560674382567964729';
const assignedBetAdministrators = new Map();
const apostaConfirmations = new Map();
const apostaThreadMeta = new Map();
const unavailableBetStarterMessageIds = new Set();
const acceptedTeladorByChannel = new Map();
const acceptedAnalystByChannel = new Map();
const isBetPaymentChannelName = name => /^(?:💸)?pagar-/i.test(String(name || ''));
const isIgnorableGuildMemberError = error => {
  if (!error) return false;

  const code = error.code ?? error.rawError?.code;
  const status = error.status ?? error.rawError?.status;
  const message = [error.message, error.rawError?.message].filter(Boolean).join(' ');

  return code === 50001 || status === 403 || /missing access/i.test(message);
};
const isUnknownGuildMemberError = error => {
  if (!error) return false;

  const code = error.code ?? error.rawError?.code;
  const message = [error.message, error.rawError?.message].filter(Boolean).join(' ');

  return Number(code) === 10007 || /unknown member/i.test(message);
};

const fetchGuildMembers = createGuildMembersCache((guild, error) => {
  console.error(`Erro ao buscar membros do servidor ${guild.id}; usando os membros disponíveis em cache:`, error);
});
let mediadorTurnIndex = 0;
const mediadorControlQueuePath = path.join(__dirname, '..', 'mediador-control-queue.json');

const readRoleIds = (...keys) => {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) {
      return value.split(',').map(id => id.trim()).filter(Boolean);
    }
  }
  return [];
};

const supportRoleIds = readRoleIds('SUPPORT_ROLE_IDS', 'support_role_ids', 'SUPPORT_ROLES_ID', 'support_roles_id');
const queueManagerRoleIds = readRoleIds('QUEUE_MANAGER_ROLE_IDS', 'queue_manager_role_ids', 'QUEUE_MANAGERS_ROLE_IDS', 'queue_managers_roles_id');
const filasRoleIds = readRoleIds('FILAS_ROLE_ID', 'filas_role_id', 'FILAS_ROLES_ID', 'filas_roles_id');
const teladorRoleIds = readRoleIds('TELADOR_ROLES_ID', 'telador_roles_id', 'TELADOR_ROLES_IDS', 'telador_roles_ids');
const ssAnalystIds = readRoleIds('SSANALISTA_ID', 'SSANALISTA_IDS', 'SS_ANALISTA_ID', 'SS_ANALISTA_IDS');
const auxiliarRoleIds = readRoleIds('AUXILIAR_ID', 'AUXILIAR_IDS', 'AUXILIAR_ROLE_ID', 'AUXILIAR_ROLES_ID');
const mediadorIds = [...new Set(
  ['MEDIADOR_ID', 'MEDIADORES_IDS', 'MEDIATOR_ID', 'MEDIATORS_IDS']
    .flatMap(key => {
      const value = process.env[key];
      return value ? value.split(',').map(id => id.trim()).filter(Boolean) : [];
    })
)].map(String);
const mediadorId = mediadorIds[0] || null;
const teladorChannelId = process.env.TELADOR_ID;
const ssmobChannelId = process.env.SSMOB_ID;
const ticketCategoryId = process.env.CATEGORY_ID;
const logChannelsConfigPath = path.join(__dirname, '..', 'logs-config.json');
let logChannelOverrides;
try {
  logChannelOverrides = loadLogChannelOverrides(logChannelsConfigPath);
} catch (error) {
  console.error('Erro ao carregar logs-config.json:', error);
  throw error;
}
let logChannels = resolveLogChannels(process.env, logChannelOverrides);
let logsChannelId = logChannels.general;
let queueLogsChannelId = logChannels.queues;
let victoryLogsChannelId = logChannels.victories;
let createdLogsChannelId = logChannels.created;
let finishedLogsChannelId = logChannels.finished;
let startedLogsChannelId = logChannels.started;
let ticketLogsChannelId = logChannels.tickets;
let mediatorLogsChannelId = logChannels.mediators;
let confirmedLogsChannelId = logChannels.confirmed;
let rejectedLogsChannelId = logChannels.rejected;
let analystLogsChannelId = logChannels.analysts;
let blacklistLogsChannelId = logChannels.blacklist;

const refreshLogChannels = () => {
  logChannels = resolveLogChannels(process.env, logChannelOverrides);
  logsChannelId = logChannels.general;
  queueLogsChannelId = logChannels.queues;
  victoryLogsChannelId = logChannels.victories;
  createdLogsChannelId = logChannels.created;
  finishedLogsChannelId = logChannels.finished;
  startedLogsChannelId = logChannels.started;
  ticketLogsChannelId = logChannels.tickets;
  mediatorLogsChannelId = logChannels.mediators;
  confirmedLogsChannelId = logChannels.confirmed;
  rejectedLogsChannelId = logChannels.rejected;
  analystLogsChannelId = logChannels.analysts;
  blacklistLogsChannelId = logChannels.blacklist;
};

const configureLogChannel = (key, channelId) => {
  if (!LOG_CHANNEL_DEFINITIONS.some(definition => definition.key === key)) {
    throw new Error(`Tipo de log inválido: ${key}`);
  }
  const updatedOverrides = { ...logChannelOverrides, [key]: channelId };
  saveLogChannelOverrides(logChannelsConfigPath, updatedOverrides);
  logChannelOverrides = updatedOverrides;
  refreshLogChannels();
};

const resetLogChannel = key => {
  if (!LOG_CHANNEL_DEFINITIONS.some(definition => definition.key === key)) {
    throw new Error(`Tipo de log inválido: ${key}`);
  }
  const updatedOverrides = { ...logChannelOverrides };
  delete updatedOverrides[key];
  saveLogChannelOverrides(logChannelsConfigPath, updatedOverrides);
  logChannelOverrides = updatedOverrides;
  refreshLogChannels();
};

const canConfigureLogChannels = (member, userId, permissions = member?.permissions) => (
  (ownerId && String(userId) === String(ownerId))
  || Boolean(permissions?.has?.(PermissionsBitField.Flags.ManageGuild))
  || Boolean(permissions?.has?.(PermissionsBitField.Flags.Administrator))
);
const apostasChannelId = process.env.APOSTAS_CHANNEL_ID;
const ownerId = process.env.OWNER_ID;
const primaryGuildId = process.env.GUILD_ID?.trim();
const pendingGuildLeaves = new Map();
const autoroleConfigPath = path.join(__dirname, '..', 'autorole.json');
let autoroleRoles = new Map();

try {
  const autoroleFile = fs.readFileSync(autoroleConfigPath, 'utf8');
  const parsed = JSON.parse(autoroleFile);
  autoroleRoles = new Map(Object.entries(parsed));
} catch (error) {
  autoroleRoles = new Map();
}

const saveAutoroleConfig = () => {
  try {
    fs.writeFileSync(autoroleConfigPath, JSON.stringify(Object.fromEntries(autoroleRoles), null, 2));
  } catch (error) {
    console.error('Erro ao salvar autorole.json:', error);
  }
};

const ticketLogsDir = path.join(__dirname, '..', 'ticket-logs');
const ticketLogsIndexPath = path.join(ticketLogsDir, 'index.json');
const queueLogsDir = path.join(__dirname, '..', 'queue-logs');
const queueLogsIndexPath = path.join(queueLogsDir, 'index.json');
const queueNumberPath = path.join(__dirname, '..', 'queue-number.json');
const userDataPath = path.join(__dirname, '..', 'user-data.json');
const lojaRolesPath = path.join(__dirname, '..', 'loja-roles.json');
const mediadorPixPath = path.join(__dirname, '..', 'mediador-pix.json');
const mediadorControlQueueStatePath = path.join(__dirname, '..', 'mediador-control-queue.json');

const ensureDir = dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const readJsonFile = filePath => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const saveJsonFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`Erro ao salvar arquivo JSON em ${filePath}:`, error);
    return false;
  }
};

const shopItems = {
  power: { name: 'Poder', price: 5, description: 'Item especial para aumentar sua força no jogo.' },
  vip: { name: 'VIP', price: 10, description: 'Acesso VIP ao conteúdo exclusivo.' },
  sorte: { name: 'Sorte', price: 3, description: 'Aumenta suas chances em minijogos.' }
};

const loadLojaRoles = () => {
  ensureDir(path.dirname(lojaRolesPath));
  const data = readJsonFile(lojaRolesPath);
  return data && typeof data === 'object' ? data : {};
};

const loadMediadorControlQueueState = () => {
  ensureDir(path.dirname(mediadorControlQueueStatePath));
  const data = readJsonFile(mediadorControlQueueStatePath);
  if (!data || typeof data !== 'object') return { queue: [], turnIndex: 0 };
  return {
    queue: Array.isArray(data.queue) ? data.queue.filter(Boolean).map(String) : [],
    turnIndex: Number.isFinite(data.turnIndex) ? data.turnIndex : 0
  };
};

const saveMediadorControlQueueState = () => saveJsonFile(mediadorControlQueueStatePath, {
  queue: mediadorControlQueue,
  turnIndex: mediadorTurnIndex
});

const lojaRoles = loadLojaRoles();
const persistedMediadorControlQueueState = loadMediadorControlQueueState();
mediadorControlQueue.push(...persistedMediadorControlQueueState.queue);
mediadorTurnIndex = persistedMediadorControlQueueState.turnIndex || 0;

const saveLojaRoles = () => saveJsonFile(lojaRolesPath, lojaRoles);

const getBetLabel = betType => {
  const labels = {
    'gel-normal': 'Gelo Normal',
    'gel-infinito': 'Gelo Infinito',
    normal: 'Normal',
    'full-ump-xm8': 'Full Ump Xm8',
    'emu-1': '1 emu',
    'emu-2': '2 emu',
    'emu-3': '3 emu'
  };
  return labels[betType] || betType;
};

const normalizeQueueMode = mode => {
  if (!mode || typeof mode !== 'string') return '1v1';
  const cleaned = mode.trim().toLowerCase();
  const validModes = ['1v1', '2v2', '3v3', '4v4'];
  return validModes.includes(cleaned) ? cleaned : '1v1';
};

const getQueueButtonLabels = (queueType, mode) => {
  const normalizedMode = normalizeQueueMode(mode);
  const isTeamMode = ['2v2', '3v3', '4v4'].includes(normalizedMode);

  if (queueType === 'Misto' && isTeamMode) {
    const emuCount = Number.parseInt(normalizedMode[0], 10) - 1;
    return Array.from({ length: emuCount }, (_, index) => ({
      label: `${index + 1} emu`,
      value: `emu-${index + 1}`,
      emoji: 'emulador'
    }));
  }

  if (normalizedMode === '1v1' || !isTeamMode) {
    return [{
      label: 'Gelo Normal',
      value: 'gel-normal',
      emoji: 'gelo'
    }, {
      label: 'Gelo Infinito',
      value: 'gel-infinito',
      emoji: 'gelo'
    }];
  }

  return [{
    label: 'Normal',
    value: 'normal',
    emoji: 'cg_certo'
  }, {
    label: 'Full Ump Xm8',
    value: 'full-ump-xm8',
    emoji: 'ump'
  }];
};

const hasRoleNameMatch = (member, names) => {
  if (!member || !Array.isArray(names) || names.length === 0) return false;
  const roles = member.roles?.cache || member.roles;
  if (!roles) return false;

  const normalizedNames = names.map(name => name.toLowerCase());
  return roles.some ? roles.some(role => normalizedNames.some(name => role.name?.toLowerCase() === name || role.name?.toLowerCase().includes(name))) : roles.some(roleId => {
    const role = member.guild?.roles?.cache?.get(roleId);
    return role && normalizedNames.some(name => role.name?.toLowerCase() === name || role.name?.toLowerCase().includes(name));
  });
};

const hasMediadorAccess = userId => {
  if (!userId) return false;
  return String(userId) === String(ownerId) || mediadorIds.includes(String(userId));
};

const isOwnerAccess = (guild, userId) => {
  if (!userId) return false;
  if (String(userId) === String(ownerId)) return true;
  if (guild && guild.ownerId && String(guild.ownerId) === String(userId)) return true;
  return false;
};

const hasTeladorRole = member => {
  if (!member) return false;
  const roles = member.roles?.cache || member.roles;
  if (!roles) return false;
  return teladorRoleIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId));
};

const hasSsAnalystAccess = member => {
  if (!member) return false;

  const userId = member.user?.id || member.id || '';
  const roles = member.roles?.cache || member.roles;

  if (ssAnalystIds.includes(String(userId))) {
    return true;
  }

  if (roles) {
    return ssAnalystIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId));
  }

  return false;
};

const hasAllowedQueueRole = member => {
  if (!member) return false;
  if (hasMediadorAccess(member.user?.id)) return true;

  const roles = member.roles?.cache || member.roles;
  if (!roles) return false;

  const byId = supportRoleIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId));
  if (byId) return true;

  return hasRoleNameMatch(member, ['mediador', 'moderador', 'suporte']);
};

const hasTicketSupportAccess = member => {
  if (!member) return false;

  const roles = member.roles?.cache || member.roles;
  if (!roles) return false;

  return supportRoleIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId))
    || auxiliarRoleIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId));
};

const hasQueueManagerRole = member => {
  if (!member) return false;
  if (member.user?.id === ownerId) return true;
  if (member.user?.id === mediadorId) return true;

  const roles = member.roles?.cache || member.roles;
  if (!roles) return false;

  const byId = queueManagerRoleIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId));
  if (byId) return true;

  return false;
};

const canManageMediadorQueue = (guild, member, userId) => {
  if (isOwnerAccess(guild, userId)) return true;
  const roles = member?.roles?.cache || member?.roles;
  if (!roles) return false;
  return supportRoleIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId));
};

const hasQueueLogAccess = (member, userId) => {
  if (userId && ownerId && String(userId) === String(ownerId)) return true;
  if (!member) return false;
  const roles = member.roles?.cache || member.roles;
  if (!roles) return false;
  return supportRoleIds.some(roleId => roles.has ? roles.has(roleId) : roles.includes(roleId));
};

const buildMediadorQueueText = () => {
  if (mediadorControlQueue.length === 0) {
    return 'Nenhum mediador na fila.';
  }

  return mediadorControlQueue
    .map((userId, index) => `${index + 1}. <@${userId}>`)
    .join('\n');
};

const buildMediadorActionRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('mediador-enter').setLabel('Entrar na fila').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId('mediador-leave').setLabel('Sair da fila').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId('mediador-manage').setLabel('⚙️').setStyle(ButtonStyle.Secondary)
);

const MEDIADOR_MANAGE_PAGE_SIZE = 25;

const buildMediadorManageMessage = async (guild, panelChannelId, panelMessageId, offset = 0, notice = '') => {
  const maxOffset = Math.max(0, Math.ceil(mediadorControlQueue.length / MEDIADOR_MANAGE_PAGE_SIZE) - 1) * MEDIADOR_MANAGE_PAGE_SIZE;
  const pageOffset = Math.min(
    maxOffset,
    Math.max(0, Math.floor(offset / MEDIADOR_MANAGE_PAGE_SIZE) * MEDIADOR_MANAGE_PAGE_SIZE)
  );
  const queueUsers = mediadorControlQueue.slice(pageOffset, pageOffset + MEDIADOR_MANAGE_PAGE_SIZE);
  const members = await Promise.all(queueUsers.map(async userId => {
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    return { userId, name: member?.displayName || member?.user?.username || `ID ${userId}` };
  }));
  const totalPages = Math.max(1, Math.ceil(mediadorControlQueue.length / MEDIADOR_MANAGE_PAGE_SIZE));
  const currentPage = Math.floor(pageOffset / MEDIADOR_MANAGE_PAGE_SIZE) + 1;
  const description = mediadorControlQueue.length === 0
    ? [notice, 'Não há mediadores na fila de controle.'].filter(Boolean).join('\n')
    : [
      notice,
      'Selecione abaixo o mediador que deseja remover da fila.',
      ...members.map((member, index) => `${pageOffset + index + 1}. ${member.name}`)
    ].filter(Boolean).join('\n');
  const embed = new EmbedBuilder()
    .setTitle('Gerenciar mediadores')
    .setDescription(description)
    .setColor(0x3498db)
    .setFooter({ text: `Página ${currentPage}/${totalPages}` });
  const components = [];

  if (members.length > 0) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`mediador-manage-select:${panelChannelId}:${panelMessageId}:${pageOffset}`)
        .setPlaceholder('Selecione quem remover da fila')
        .addOptions(members.map((member, index) => ({
          label: `${pageOffset + index + 1}. ${member.name}`.slice(0, 100),
          value: member.userId,
          description: 'Remover este mediador da fila'
        })))
    ));
  }

  if (totalPages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mediador-manage-page:${panelChannelId}:${panelMessageId}:${Math.max(0, pageOffset - MEDIADOR_MANAGE_PAGE_SIZE)}`)
        .setLabel('Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageOffset === 0),
      new ButtonBuilder()
        .setCustomId(`mediador-manage-page:${panelChannelId}:${panelMessageId}:${pageOffset + MEDIADOR_MANAGE_PAGE_SIZE}`)
        .setLabel('Próxima')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageOffset + MEDIADOR_MANAGE_PAGE_SIZE >= mediadorControlQueue.length)
    ));
  }

  return { embeds: [embed], components };
};

const buildMediadorPanelEmbed = () => new EmbedBuilder()
  .setTitle('Painel de Mediador')
  .setDescription(buildMediadorQueueText())
  .setColor(0x3498db)
  .setTimestamp();

const buildMediadorPixPanel = () => new EmbedBuilder()
  .setTitle('💠 Painel de Cadastros de Pix')
  .setDescription('Cadastre sua chave pix ou verifique cadastros nos botões abaixo.')
  .setColor(0xffeb3b);

const getMediadorProfileStats = userId => mediadorProfile.getMediadorProfileStats(String(userId));

const buildMediadorProfileEmbed = (targetUser, userId) => {
  const stats = getMediadorProfileStats(userId);
  const totalSeconds = mediadorProfile.getMediadorHoursValue(stats);
  const pixData = mediadorPixData.get(userId) || {};
  const rankEntries = mediadorProfile.getMediadorRankingEntries();
  const rankPosition = rankEntries.findIndex(entry => entry.userId === userId) + 1;
  const topRankLines = rankEntries.slice(0, 3).map((entry, index) => `**${index + 1}°** <@${entry.userId}> • ${mediadorProfile.formatMediadorHours(entry.totalSeconds)} • ${entry.completedQueues} filas concluídas`);

  const embed = new EmbedBuilder()
    .setTitle(`Perfil de Mediador - ${targetUser.username}`)
    .setDescription('Informações sobre o tempo na fila de controle, dados de PIX e o ranking dos mediadores.')
    .setColor(0x3498db)
    .setTimestamp()
    .addFields(
      { name: 'Nome', value: `${targetUser.tag}`, inline: false },
      { name: 'Em fila de controle', value: stats.inQueueSince ? 'Sim' : 'Não', inline: true },
      { name: 'Horas na fila', value: mediadorProfile.formatMediadorHours(totalSeconds), inline: true },
      { name: 'Filas concluídas', value: `${stats.completedQueues || 0}`, inline: true },
      { name: 'Banco / Nome', value: pixData.bankName || 'Não informado', inline: false },
      { name: 'Chave Pix', value: pixData.pixKey || 'Não informado', inline: true },
      { name: 'Mensagem', value: pixData.message || 'Não informada', inline: false },
      { name: 'Posição no rank', value: rankPosition > 0 ? `${rankPosition}°` : 'Sem posição', inline: true },
      { name: 'Top do rank', value: topRankLines.length ? topRankLines.join('\n') : 'Nenhum registro disponível', inline: false }
    );

  if (stats.inQueueSince) {
    embed.addFields({ name: 'Fila ativa desde', value: `<t:${Math.floor(stats.inQueueSince / 1000)}:R>`, inline: false });
  }

  return embed;
};

const buildMediadorRankMedEmbed = entries => {
  const lines = entries.slice(0, 10).map((entry, index) => `**${index + 1}°** <@${entry.userId}> • ${mediadorProfile.formatMediadorHours(entry.totalSeconds)} • ${entry.completedQueues} filas concluídas`);
  return new EmbedBuilder()
    .setTitle('Ranking de Mediadores - Horas na fila')
    .setDescription(lines.length ? lines.join('\n') : 'Nenhum registro de mediadores encontrado.')
    .setColor(0x3498db)
    .setTimestamp();
};

const getTeladorProfileStats = userId => teladorProfile.getTeladorProfileStats(String(userId));

const buildTeladorProfileEmbed = (targetUser, userId) => {
  const stats = getTeladorProfileStats(userId);
  const entries = teladorProfile.getTeladorRankingEntries();
  const rankPosition = entries.findIndex(entry => entry.userId === userId) + 1;
  const topLines = entries.slice(0, 5).map((entry, index) => `**${index + 1}°** <@${entry.userId}> • ${entry.telagens} telagens`);

  return new EmbedBuilder()
    .setTitle(`Perfil de Telador - ${targetUser.username}`)
    .setDescription('Mostra o total de telagens do telador e sua posição no ranking.')
    .setColor(0x3498db)
    .addFields(
      { name: 'Nome', value: `${targetUser.tag}`, inline: false },
      { name: 'Total de telagens', value: `${stats.telagens}`, inline: true },
      { name: 'Posição no rank', value: rankPosition > 0 ? `${rankPosition}°` : 'Sem posição', inline: true },
      { name: 'Top do rank', value: topLines.length ? topLines.join('\n') : 'Nenhum telador registrado ainda', inline: false }
    )
    .setTimestamp();
};

const buildTeladorRankTldEmbed = entries => {
  const lines = entries.slice(0, 10).map((entry, index) => `**${index + 1}°** <@${entry.userId}> • ${entry.telagens} telagens`);
  return new EmbedBuilder()
    .setTitle('Ranking de Teladores')
    .setDescription(lines.length ? lines.join('\n') : 'Nenhum telador registrado ainda.')
    .setColor(0x3498db)
    .setTimestamp();
};

const getAnalistaProfileStats = userId => analistaProfile.getAnalistaProfileStats(String(userId));

const isSnowflakeId = id => typeof id === 'string' && /^[0-9]+$/.test(id);

const buildAnalistaProfileEmbed = (targetUser, userId, rankMentions = {}) => {
  const stats = getAnalistaProfileStats(userId);
  const entries = analistaProfile.getAnalistaRankingEntries();
  const rankPosition = entries.findIndex(entry => entry.userId === userId) + 1;
  const topLines = entries.slice(0, 5).map((entry, index) => {
    const mention = rankMentions[entry.userId] || (isSnowflakeId(entry.userId) ? `<@${entry.userId}>` : `@${entry.userId}`);
    return `**${index + 1}°** ${mention} • ${entry.analises} análises`;
  });

  return new EmbedBuilder()
    .setTitle(`Perfil de Analista - ${targetUser.username}`)
    .setDescription('Mostra o total de análises do analista e sua posição no ranking.')
    .setColor(0x3498db)
    .addFields(
      { name: 'Usuário', value: `${targetUser.toString()} (${targetUser.tag})`, inline: false },
      { name: 'Total de análises', value: `${stats.analises}`, inline: true },
      { name: 'Posição no rank', value: rankPosition > 0 ? `${rankPosition}°` : 'Sem posição', inline: true },
      { name: 'Top do rank', value: topLines.length ? topLines.join('\n') : 'Nenhum analista registrado ainda', inline: false }
    )
    .setTimestamp();
};

const buildAnalistaRankEmbed = (entries, rankMentions = {}) => {
  const lines = entries.slice(0, 10).map((entry, index) => {
    const mention = rankMentions[entry.userId] || (isSnowflakeId(entry.userId) ? `<@${entry.userId}>` : `@${entry.userId}`);
    return `**${index + 1}°** ${mention} • ${entry.analises} análises`;
  });

  return new EmbedBuilder()
    .setTitle('Ranking de Analistas')
    .setDescription(lines.length ? lines.join('\n') : 'Nenhum analista registrado ainda.')
    .setColor(0x3498db)
    .setTimestamp();
};

const buildAnalistaRankMentions = async ids => {
  const mentions = {};
  for (const id of ids) {
    if (!isSnowflakeId(id)) continue;
    let user = client.users.cache.get(id);
    if (!user) {
      user = await client.users.fetch(id).catch(() => null);
    }
    if (user) {
      mentions[id] = user.toString();
    }
  }
  return mentions;
};

const stopMediadorQueueSessionForUser = (userId, endedAt = Date.now()) => {
  const stats = getMediadorProfileStats(userId);
  const startedAt = Number(stats?.inQueueSince) || null;
  const queuesTaken = Number(stats?.queuesTakenThisSession) || 0;
  if (startedAt) {
    mediadorProfile.stopMediadorQueueSession(stats, endedAt);
  }

  return {
    startedAt,
    endedAt,
    queuesTaken,
    durationSeconds: startedAt
      ? Math.max(0, Math.floor((endedAt - startedAt) / 1000))
      : 0
  };
};

const startMediadorQueueSessionForUser = userId => {
  const stats = getMediadorProfileStats(userId);
  if (stats && !stats.inQueueSince) {
    mediadorProfile.startMediadorQueueSession(stats);
  }
  return Number(stats?.inQueueSince) || null;
};

const parseQueuePlayersFromEmbed = embed => {
  if (!embed?.fields) return [];

  const playerFields = (embed.fields || []).filter(field => /jogador(?:es)?/i.test(String(field.name || '')));
  const parsedPlayers = [];
  const seenIds = new Set();

  const pushPlayer = (playerId, label = '') => {
    if (!playerId || seenIds.has(playerId)) return;
    seenIds.add(playerId);
    parsedPlayers.push({ id: String(playerId), label: String(label || '') });
  };

  for (const field of playerFields) {
    const value = String(field.value || '');
    if (!value || value.trim() === 'Nenhum jogador na fila') continue;

    for (const line of value.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const mentionMatch = trimmed.match(/<@!?(\d+)>/);
      const idMatch = mentionMatch ? mentionMatch[1] : trimmed.match(/^(\d+)$/)?.[1];
      if (!idMatch) continue;

      const labelMatch = trimmed.match(/\((.+)\)\s*$/);
      pushPlayer(idMatch, labelMatch ? labelMatch[1] : '');
    }
  }

  if (parsedPlayers.length === 0) {
    const descriptionIds = extractMentionedUserIds(embed.description || '');
    for (const id of descriptionIds) {
      pushPlayer(id, '');
    }
  }

  return parsedPlayers;
};

const mergeQueuePlayerLabels = (currentLabel = '', newLabel = '') => {
  const labels = String(currentLabel || '')
    .split(/\s*[|,/]+\s*/)
    .map(label => label.trim())
    .filter(Boolean);

  if (labels.includes(newLabel)) return labels.join(' | ');
  labels.push(newLabel);
  return labels.join(' | ');
};

const getPlayerQueueLabels = (player = {}) => {
  if (!player || typeof player !== 'object') return [];
  return String(player.label || '')
    .split(/\s*[|,/]+\s*/)
    .map(label => label.trim())
    .filter(Boolean);
};

const extractMentionedUserIds = value => [...new Set((value || '').match(/<@!?(\d+)>/g) || [])]
  .map(mention => mention.replace(/<@!?|>/g, ''));

const parseCurrencyToCents = value => {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value)
    .replace(/[^0-9,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const extractRoomCredentials = text => {
  if (!text || typeof text !== 'string') return { roomId: null, roomPassword: null };

  // Capture sequências de dígitos no texto (2 a 11 dígitos) e escolha o mais apropriado
  const matches = Array.from((text.matchAll(/(\d{2,11})/g) || []), m => m[1]);
  if (matches.length === 0) return { roomId: null, roomPassword: null };

  const roomId = matches.find(m => m.length >= 6 && m.length <= 11) || null;
  const roomPassword = matches.find(m => m.length >= 2 && m.length <= 6 && m !== roomId) || null;

  return { roomId, roomPassword };
};

const formatCentsToCurrency = cents => {
  const safeCents = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
  return `R$ ${(safeCents / 100).toFixed(2).replace('.', ',')}`;
};

const buildRoomCreatedPanel = ({
  roomId,
  roomPassword,
  betCents = 0,
  mode = null,
  queueType = null,
  betType = null,
  mediatorId = null
}) => {
  const modeAndQueue = [String(mode || '').trim(), String(queueType || '').trim()].filter(Boolean).join(' ');
  const modeLabel = [modeAndQueue, betType ? getBetLabel(betType) : ''].filter(Boolean).join(' | ');

  return new EmbedBuilder()
    .setTitle('Partida Iniciada - ID e Senha')
    .setDescription([
      '> Em 3 minutos a sala será iniciada!',
      '',
      `↪ **ID:** \`${roomId || 'Não informado'}\``,
      `↪ **Senha:** \`${roomPassword || 'Não informada'}\``,
      `↪ **Modo:** ${modeLabel || 'Não informado'}`,
      `↪ **Valor a pagar:** ${formatCentsToCurrency(betCents)}`,
      `↪ **Mediador:** ${mediatorId ? `<@${mediatorId}>` : 'Não informado'}`
    ].join('\n'))
    .setColor(0xe50914)
    .setTimestamp();
};

const buildRoomControlRow = (roomId, guild) => new ActionRowBuilder().addComponents(
  applyGuildEmojiToButton(
    new ButtonBuilder().setCustomId(`room-copy-id:${roomId}`).setLabel('Copiar ID').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    guild,
    'agenda~1'
  ),
  applyGuildEmojiToButton(
    new ButtonBuilder().setCustomId('room-edit-room').setLabel('Trocar Valor').setStyle(ButtonStyle.Secondary),
    guild,
    'dinheiro'
  )
);

const publishRoomPanel = async ({ targetChannel, threadMeta, roomId, roomPassword }) => {
  const playerMentions = (threadMeta.playerIds || []).map(id => `<@${id}>`).join(' ');
  const roomEmbed = buildRoomCreatedPanel({
    roomId,
    roomPassword,
    betCents: threadMeta.betCents || 0,
    mode: threadMeta.mode || null,
    queueType: threadMeta.queueType || null,
    betType: threadMeta.selectedBetType || null,
    mediatorId: assignedBetAdministrators.get(targetChannel.id) || null
  });

  const roomPanelMessage = await targetChannel.send({
    content: playerMentions || 'Sala criada',
    embeds: [roomEmbed],
    components: [buildRoomControlRow(roomId, targetChannel.guild)]
  });

  threadMeta.roomCreated = true;
  delete threadMeta.pendingRoomId;
  delete threadMeta.pendingRoomPassword;
  await sendLogEmbed(
    targetChannel.guild,
    startedLogsChannelId,
    'Partida iniciada',
    `Canal: <#${targetChannel.id}>\nJogadores: ${playerMentions || 'Não informado'}\nMediador: ${assignedBetAdministrators.get(targetChannel.id) ? `<@${assignedBetAdministrators.get(targetChannel.id)}>` : 'Não informado'}\nModo: ${[threadMeta.mode, threadMeta.queueType].filter(Boolean).join(' ') || 'Não informado'}\nValor: ${formatCentsToCurrency(threadMeta.betCents || 0)}\nID da sala: ${roomId || 'Não informado'}`,
    0xe50914,
    'partidas-iniciadas',
    targetChannel.id
  );
  const channelCents = (Number(threadMeta.betCents) || 0) * 2;
  const formattedTotal = formatCentsToCurrency(channelCents).replace('R$ ', '');
  try {
    await targetChannel.setName(`💸pagar-${formattedTotal}`);
  } catch (error) {
    console.error(`Erro ao atualizar o nome do tópico ${targetChannel.id}:`, error);
  }

  return roomPanelMessage;
};

const buildPixQrReply = async (pixKey, amountCents, receiverName) => {
  const pixPayload = buildPixPayload({ pixKey, amountCents, receiverName });
  const qrCode = await QRCode.toBuffer(pixPayload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512
  });
  const qrAttachment = new AttachmentBuilder(qrCode, { name: 'pix-qrcode.png' });
  const qrEmbed = new EmbedBuilder()
    .setTitle('QR Code Pix')
    .setDescription(amountCents
      ? `Valor: **${formatCentsToCurrency(amountCents)}**`
      : 'QR Code Pix sem valor definido.')
    .setImage('attachment://pix-qrcode.png')
    .addFields({ name: 'Pix copia e cola', value: `\`${pixPayload}\`` })
    .setColor(0x3498db)
    .setTimestamp();

  return { embeds: [qrEmbed], files: [qrAttachment] };
};

const getPlayersFieldValue = embed => {
  const field = embed?.fields?.find(f => String(f.name || '').includes('Jogadores'));
  return field?.value || '';
};

const getNextAssignedMediador = () => {
  if (mediadorControlQueue.length === 0) return null;
  const currentMediadorId = mediadorControlQueue[mediadorTurnIndex % mediadorControlQueue.length];
  mediadorTurnIndex = (mediadorTurnIndex + 1) % mediadorControlQueue.length;
  return currentMediadorId;
};

const createApostaThread = async (guild, playerIds, betLabel, queueType, mode, formattedValue, selectedBetType) => {
  if (!apostasChannelId) return null;
  const apostasChannel = await guild.channels.fetch(apostasChannelId).catch(() => null);
  if (!apostasChannel || !apostasChannel.isTextBased()) return null;

  const playerIdList = Array.isArray(playerIds)
    ? [...new Set(playerIds.map(String).filter(Boolean))]
    : [String(playerIds)].filter(Boolean);

  if (playerIdList.length < 2) return null;

  let queueViewerMembers = [];
  if (filasRoleIds.length > 0) {
    const guildMembers = await fetchGuildMembers(guild);
    queueViewerMembers = [...guildMembers.values()].filter(member => (
      !member.user.bot && filasRoleIds.some(roleId => member.roles.cache.has(roleId))
    ));
  }

  let queueNumber;
  try {
    queueNumber = allocateQueueNumber(queueNumberPath);
  } catch (error) {
    console.error('Erro ao reservar o número da fila:', error);
    return null;
  }
  const assignedMediadorId = getNextAssignedMediador();

  let thread;
  try {
    thread = await apostasChannel.threads.create({
      name: 'aguardando',
      autoArchiveDuration: 1440,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `Aposta criada entre ${playerIdList.join(' e ')}`
    });
  } catch (error) {
    console.error('Erro ao criar thread de aposta:', error);
    return null;
  }

  const threadMemberIds = [...new Set([
    ...playerIdList,
    ...queueViewerMembers
      .filter(member => member.id !== assignedMediadorId)
      .map(member => member.id)
  ])];
  try {
    for (const memberId of threadMemberIds) {
      try {
        await thread.members.add(memberId);
      } catch (error) {
        if (isIgnorableGuildMemberError(error)) {
          console.warn(`Ignorando falha ao adicionar membro ${memberId} à thread ${thread.id}:`, error.message || error.rawError?.message || 'Missing Access');
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    console.error(`Erro ao adicionar jogadores ou visualizadores à thread ${thread.id}:`, error);
    try {
      await thread.delete('Não foi possível configurar os membros da fila.');
    } catch (deleteError) {
      console.error(`Erro ao excluir a thread ${thread.id} após falha ao adicionar membros:`, deleteError);
    }
    return null;
  }

  const queueData = getGuildFFQueue(guild.id);
  const feeCents = Number(queueData?.queues?.[queueType]?.settings?.feeCents || queueData?.feeCents || 0);
  const betCents = parseCurrencyToCents(formattedValue || betLabel);
  const playerNames = await Promise.all(playerIdList.map(async playerId => {
    let member = guild.members.cache.get(playerId);
    if (!member) {
      try {
        member = await guild.members.fetch(playerId);
      } catch (error) {
        console.warn(`Não foi possível registrar o nome do jogador ${playerId} na fila ${thread.id}:`, error);
      }
    }
    return member?.displayName || member?.user?.username || '';
  }));

  assignedBetAdministrators.set(thread.id, assignedMediadorId);
  if (assignedMediadorId) {
    const assignedMediatorStats = getMediadorProfileStats(assignedMediadorId);
    mediadorProfile.recordMediadorQueueTaken(assignedMediatorStats);
  }
  apostaConfirmations.set(thread.id, new Set());
  apostaThreadMeta.set(thread.id, {
    selectedBetType: selectedBetType || null,
    queueNumber,
    queueType,
    mode,
    betCents,
    feeCents,
    betValueText: formattedValue || betLabel,
    playerIds: playerIdList,
    playerNames,
    pixReleased: false,
    createdAt: new Date().toISOString()
  });

  const playersText = playerIdList.map(id => `<@${id}>`).join('\n');
  const playersEmbedText = playerIdList
    .map((id, index) => `<@${id}>${playerNames[index] ? ` (${playerNames[index]})` : ''}`)
    .join('\n');
  const queueLabel = ffQueueTypes[queueType]?.label || queueType;
  const modeLabel = mode.toUpperCase();
  const queueEmoji = getQueueModeEmoji(guild, queueType);
  const valueEmoji = getQueueValueEmoji(guild);
  const playersEmoji = getQueuePlayersEmoji(guild);
  const valueLabel = formattedValue || betLabel;
  const filaMentions = filasRoleIds.length > 0 ? filasRoleIds.map(roleId => `<@&${roleId}>`).join(' ') : (ownerId ? `Dono: <@${ownerId}>` : 'Não configurado');
  const assignedMediadorText = assignedMediadorId ? `<@${assignedMediadorId}>` : '';

  const embed = new EmbedBuilder()
    .setTitle('Esperando Confirmar')
    .setColor(0x3498db)
    .addFields(
      { name: `${queueEmoji || getGuildEmojiMarkup(guild, 'mobile') || '📱'} Modo:`, value: `${modeLabel} ${queueLabel}`, inline: false },
      { name: `${valueEmoji} Valor:`, value: valueLabel, inline: false },
      { name: `${playersEmoji} Jogadores:`, value: playersEmbedText, inline: false }
  );

  const buttons = new ActionRowBuilder().addComponents(
    applyGuildEmojiToButton(
      new ButtonBuilder().setCustomId('aposta-confirm').setLabel('Confirmar').setStyle(ButtonStyle.Success),
      guild,
      'CheckV'
    ),
    applyGuildEmojiToButton(
      new ButtonBuilder().setCustomId('aposta-cancel').setLabel('Cancelar').setStyle(ButtonStyle.Danger),
      guild,
      'errado'
    )
  );

  await thread.send({
    content: `${playersText.replace(/\n/g, ' ')} | ${filaMentions}`,
    embeds: [embed],
    components: [buttons]
  }).catch(() => null);
  try {
    await thread.send({ embeds: [buildQueueRulesEmbed()] });
  } catch (error) {
    console.error(`Erro ao publicar as regras padrão na aposta ${thread.id}:`, error);
  }

  const firstText = playerIdList[0] ? `<@${playerIdList[0]}>` : 'Não informado';
  const secondText = playerIdList[1] ? `<@${playerIdList[1]}>` : 'Não informado';

  if (createdLogsChannelId && guild) {
    await sendLogEmbed(
      guild,
      createdLogsChannelId,
      'Fila aberta',
      `Aposta aberta por: ${firstText} e ${secondText}\nMediador: ${assignedMediadorText || 'Não informado'}\nTipo: ${queueLabel}\nModo: ${String(mode || 'N/A').toUpperCase()}\nValor: ${valueLabel}`,
      0xffffff,
      'apostas-criadas',
      thread.id
    );
  }

  if (mediatorLogsChannelId && guild) {
    await sendLogEmbed(
      guild,
      mediatorLogsChannelId,
      'Mediador designado',
      `Mediador: ${assignedMediadorText || 'Não informado'}\nJogadores: ${firstText} e ${secondText}\nFila: ${thread}`,
      0xffffff,
      'mediadores',
      thread.id
    );
  }

  return thread;
};

const loadUserData = () => {
  ensureDir(path.dirname(userDataPath));
  const data = readJsonFile(userDataPath);
  return data && typeof data === 'object' ? data : {};
};

const saveUserData = data => saveJsonFile(userDataPath, data);

const loadMediadorPixData = () => {
  ensureDir(path.dirname(mediadorPixPath));
  const data = readJsonFile(mediadorPixPath);
  if (!data || typeof data !== 'object') return new Map();
  return new Map(Object.entries(data));
};

const saveMediadorPixData = () => saveJsonFile(mediadorPixPath, Object.fromEntries(mediadorPixData));

const blacklistPath = path.join(__dirname, '..', 'blacklist.json');
const readBlacklist = () => {
  try {
    if (!fs.existsSync(blacklistPath)) return [];
    return JSON.parse(fs.readFileSync(blacklistPath, 'utf8')) || [];
  } catch {
    return [];
  }
};
const saveBlacklist = (list) => {
  try {
    fs.writeFileSync(blacklistPath, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Erro ao salvar blacklist:', error);
    return false;
  }
};

const getLogChannel = async (guild, channelId, context) => {
  if (!guild) return null;
  if (!channelId) {
    console.warn(`Aviso: canal de logs para ${context} não está configurado.`);
    return null;
  }
  try {
    return await guild.channels.fetch(channelId);
  } catch (error) {
    console.error(`Erro ao buscar canal de logs para ${context} (${channelId}):`, error);
    return null;
  }
};

const sendLogEmbed = async (guild, channelId, title, description, color = 0x3498db, context = 'log', queueId = null) => {
  const logChannel = await getLogChannel(guild, channelId, context);
  if (!logChannel) return false;
  if (!logChannel.isTextBased?.()) {
    console.warn(`Aviso: canal de ${context} configurado não é um canal de texto.`);
    return false;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
  if (queueId) embed.setFooter({ text: `queueId:${queueId}` });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error(`Erro ao enviar log para o canal ${channelId} (${context}):`, error);
    return false;
  }
  return true;
};

const sendBetResultLogs = async (guild, title, description, color, queueId, hasWinner) => {
  const channelIds = [...new Set([
    finishedLogsChannelId,
    hasWinner ? victoryLogsChannelId : null
  ].filter(Boolean))];

  for (const channelId of channelIds) {
    await sendLogEmbed(guild, channelId, title, description, color, 'apostas-finalizadas', queueId);
  }
};

const getEmbedText = embed => {
  if (!embed) return '';
  const lines = [];
  if (embed.title) lines.push(embed.title);
  if (embed.description) lines.push(embed.description);
  if (Array.isArray(embed.fields)) {
    for (const field of embed.fields) {
      lines.push(`${field.name}: ${field.value}`);
    }
  }
  return lines.join('\n');
};

const parseQueueLogMessage = message => {
  if (!message || !message.embeds || message.embeds.length === 0) return null;
  const embed = message.embeds[0];
  const queueTitles = [
    'Aposta aberta',
    'Aposta confirmada',
    'Aposta finalizada',
    'Aposta finalizada por W.O',
    'Aposta finalizada sem vencedor',
    'Fila aberta',
    'Fila cancelada',
    'Fila publicada',
    'Filas publicadas',
    'Partida iniciada'
  ];
  if (!embed.title || !queueTitles.includes(embed.title)) return null;
  const text = getEmbedText(embed);
  return {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    queueId: embed.footer?.text?.match(/^queueId:(\d+)$/)?.[1] || null,
    title: embed.title,
    text,
    timestamp: message.createdTimestamp || message.createdAt?.getTime() || Date.now(),
    rawContent: message.content || ''
  };
};

const findQueueLogsForUser = async (guild, userId) => {
  const channelIds = [...new Set([
    queueLogsChannelId,
    createdLogsChannelId,
    finishedLogsChannelId,
    victoryLogsChannelId,
    startedLogsChannelId,
    confirmedLogsChannelId,
    rejectedLogsChannelId
  ].filter(Boolean))];
  if (channelIds.length === 0) return [];
  const logsByEvent = new Map();
  const maxFetch = 200;
  for (const channelId of channelIds) {
    const channel = await getLogChannel(guild, channelId, 'filas');
    if (!channel || !channel.isTextBased?.() || !channel.messages?.fetch) continue;
    let before = null;

    while (logsByEvent.size < maxFetch) {
      const fetchOptions = { limit: 100 };
      if (before) fetchOptions.before = before;
      const messages = await channel.messages.fetch(fetchOptions).catch(error => {
        console.error(`Erro ao buscar registros de fila no canal ${channelId}:`, error);
        return null;
      });
      if (!messages || messages.size === 0) break;

      for (const message of messages.values()) {
        const parsed = parseQueueLogMessage(message);
        if (!parsed) continue;
        const mentionPattern = new RegExp(`<@!?${userId}>`);
        if (mentionPattern.test(parsed.text) || parsed.text.includes(userId) || (message.content || '').includes(userId)) {
          const eventKey = parsed.queueId ? `${parsed.queueId}:${parsed.title}` : parsed.messageId;
          const existingEntry = logsByEvent.get(eventKey);
          if (!existingEntry || parsed.timestamp > existingEntry.timestamp) {
            logsByEvent.set(eventKey, parsed);
          }
        }
      }

      before = messages.last()?.id;
      if (!before || logsByEvent.size >= maxFetch) break;
    }
  }

  for (const archivedEntry of buildArchivedQueueLogEntries(loadQueueLogIndex(), userId, loadQueueLogFile)) {
    const eventKey = `${archivedEntry.queueId}:${archivedEntry.title}`;
    const existingEntry = logsByEvent.get(eventKey);
    if (!existingEntry || archivedEntry.timestamp > existingEntry.timestamp) {
      logsByEvent.set(eventKey, archivedEntry);
    }
  }

  const logs = [...logsByEvent.values()];
  return logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, 25);
};

const findTicketLogsForUser = userId => {
  if (!fs.existsSync(ticketLogsIndexPath)) return [];
  const indexData = readJsonFile(ticketLogsIndexPath);
  if (!Array.isArray(indexData)) {
    console.error('O índice de logs de tickets precisa ser uma lista JSON.');
    return [];
  }

  return indexData
    .filter(entry => (
      entry
      && String(entry.ownerId) === String(userId)
      && /^\d{17,19}$/.test(String(entry.ticketId || ''))
      && fs.existsSync(path.join(ticketLogsDir, `${entry.ticketId}.json`))
    ))
    .slice(0, 25)
    .map(entry => ({
      value: String(entry.ticketId),
      label: `${entry.channelName || 'Ticket'} • ${entry.ticketType || 'suporte'} • ${new Date(entry.closedAt).toLocaleDateString('pt-BR')}`,
      description: `Finalizado em ${new Date(entry.closedAt).toLocaleString('pt-BR')}`,
      ...entry
    }));
};

const loadTicketLog = ticketId => {
  if (!/^\d{17,19}$/.test(String(ticketId || ''))) return null;
  return readJsonFile(path.join(ticketLogsDir, `${ticketId}.json`));
};

const filterQueueLogsByOutcome = (entries, outcome) => entries.filter(entry => {
  const title = String(entry.title || '').toLocaleLowerCase('pt-BR');
  if (outcome === 'cancelled') return title.includes('cancelad') || title.includes('recusad');
  return title.includes('finaliz');
});

const buildQueueLogsMenu = (targetUser, entries) => {
  const options = entries.map(entry => ({
    label: `${entry.title} - ${new Date(entry.timestamp).toLocaleString('pt-BR')}`.slice(0, 100),
    value: entry.messageId,
    description: entry.text.slice(0, 80) || 'Sem detalhes'
  }));
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`logs-select:${targetUser.id}`)
      .setPlaceholder(`Selecione a fila de ${targetUser.username}`)
      .addOptions(options)
  );
  const embed = new EmbedBuilder()
    .setTitle(`Logs de filas de ${targetUser.username}`)
    .setDescription(`Foram encontradas **${entries.length}** entradas de fila para ${targetUser}. Selecione uma para ver detalhes.`)
    .setColor(0x3498db)
    .setTimestamp();

  return { embed, components: [row] };
};

const buildQueueLogDetail = (targetUserId, entry, index, total) => {
  const logLines = entry.text.split('\n');
  if (logLines[0] === entry.title) logLines.shift();
  const details = logLines.join('\n').trim() || 'Sem detalhes adicionais.';
  const normalizedTitle = entry.title.toLowerCase();
  const status = normalizedTitle.includes('cancelada')
    ? '🔴 Cancelada'
    : normalizedTitle.includes('finalizada')
      ? '🟢 Concluída'
      : '📋 Registro';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('queue-logs:previous')
      .setLabel('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= total - 1),
    new ButtonBuilder()
      .setCustomId('queue-logs:next')
      .setLabel('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId('queue-logs:print')
      .setLabel('🖨️ Imprimir')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('queue-logs:web')
      .setLabel('🌐 Ver na Web')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('queue-logs:back')
      .setLabel('Voltar')
      .setStyle(ButtonStyle.Danger)
  );
  const embed = new EmbedBuilder()
    .setTitle(`Logs de <@${targetUserId}>`)
    .setDescription(`**Log ${entry.title}**\n\n${details}`.slice(0, 4096))
    .addFields({
      name: 'Status',
      value: `${status} • ${index + 1}/${total}`,
      inline: false
    })
    .setColor(0x3498db)
    .setFooter({ text: `Log ${index + 1} de ${total}` })
    .setTimestamp(new Date(entry.timestamp));

  return { embed, components: [row] };
};

const mediadorPixData = loadMediadorPixData();
const userData = loadUserData();
const ffQueuePath = path.join(__dirname, '..', 'ff-queue.json');

const loadFFQueueData = () => {
  ensureDir(path.dirname(ffQueuePath));
  const data = readJsonFile(ffQueuePath);
  return data && typeof data === 'object' ? data : {};
};

const ffQueueData = loadFFQueueData();

const saveFFQueueData = () => saveJsonFile(ffQueuePath, ffQueueData);

const getGuildFFQueue = guildId => {
  if (!ffQueueData[guildId]) {
    ffQueueData[guildId] = {
      entries: [],
      startedAt: null,
      lastStartedBy: null,
      queues: {}
    };
  }

  if (!ffQueueData[guildId].queues) {
    ffQueueData[guildId].queues = {};
  }

  for (const queueType of Object.keys(ffQueueTypes)) {
    if (!ffQueueData[guildId].queues[queueType]) {
      ffQueueData[guildId].queues[queueType] = {
        entries: [],
        settings: getQueueSettings(ffQueueData[guildId])
      };
    }

    if (!ffQueueData[guildId].queues[queueType].settings) {
      ffQueueData[guildId].queues[queueType].settings = getQueueSettings(ffQueueData[guildId]);
    }
  }

  return ffQueueData[guildId];
};

const saveGuildFFQueue = guildId => {
  const queue = getGuildFFQueue(guildId);
  queue.updatedAt = new Date().toISOString();
  saveFFQueueData();
};

const ffQueueTypes = {
  Mobile: { label: 'Mobile', emoji: '📱' },
  Emulador: { label: 'Emulador', emoji: '🖥️' },
  Misto: { label: 'Misto', emoji: '🖥️' }
};

const buildQueueThumbnail = () => {
  return {
    url: 'attachment://jordan-apostas.gif',
    isAttachment: true,
    files: [new AttachmentBuilder(path.join(__dirname, '..', 'assets', 'jordan-apostas.gif'), {
      name: 'jordan-apostas.gif'
    })]
  };
};

const buildQueueMessageEditOptions = (message, embed, components) => {
  const localThumbnailUrl = 'attachment://jordan-apostas.gif';
  const messageAttachments = [...(message.attachments?.values() || [])];
  const attachments = messageAttachments
    .filter(attachment => attachment.name !== 'jordan-apostas.gif')
    .map(attachment => ({ id: attachment.id }));

  applyQueueImageToEmbed(embed, { url: localThumbnailUrl, isAttachment: true });

  return {
    embeds: [embed],
    components,
    attachments,
    files: [new AttachmentBuilder(path.join(__dirname, '..', 'assets', 'jordan-apostas.gif'), {
      name: 'jordan-apostas.gif'
    })]
  };
};

const getQueueThumbnail = guildId => {
  const queueData = getGuildFFQueue(guildId);
  const configuredBanner = Object.keys(ffQueueTypes)
    .map(queueType => queueData.queues?.[queueType]?.settings?.banner)
    .find(banner => getQueueImage(banner).url)
    || queueData.banner
    || '';
  const queueImage = getQueueImage(configuredBanner);
  return queueImage.url ? { ...queueImage, files: [] } : buildQueueThumbnail();
};

const buildTicketPanelPayload = guildId => {
  const thumbnail = getQueueThumbnail(guildId);
  return {
    embeds: [buildTicketPanelEmbed(thumbnail.url)],
    components: [buildTicketOptionsRow()],
    files: thumbnail.files
  };
};

const getQueueSettings = queueData => ({
  defaultEntryAmount: 1,
  minPlayersToStart: 2,
  maxPlayersPerQueue: 20,
  // Valores de apostas disponíveis (array de números, ex: [0.5, 100])
  betValues: (queueData && queueData.betValues) || DEFAULT_BET_VALUES,
  // Taxa em centavos (ex: 5 significa R$0,05)
  feeCents: (queueData && queueData.feeCents) || 0,
  // URL da imagem em destaque no embed de fila
  banner: (queueData && queueData.banner) || ''
});


const buildFFQueueConfigEmbed = (queueData, queueType = 'Mobile', guild = null) => {
  const queue = queueData.queues?.[queueType] || { settings: getQueueSettings(queueData) };
  const typeInfo = ffQueueTypes[queueType] || ffQueueTypes.Mobile;

  const embed = new EmbedBuilder()
    .setTitle(`⚙️ Configuração da fila ${typeInfo.emoji} ${typeInfo.label}`)
    .setDescription('Edite os valores desta fila usando o formulário abaixo.')
    .addFields(
      { name: 'Aposta padrão', value: `${queue.settings.defaultEntryAmount} coins`, inline: true },
      { name: 'Mínimo para iniciar', value: `${queue.settings.minPlayersToStart} jogadores`, inline: true },
      { name: 'Máximo da fila', value: `${queue.settings.maxPlayersPerQueue} jogadores`, inline: true },
      { name: 'Valores das apostas', value: `${sortBetValuesDescending(queue.settings.betValues).join(', ')}`, inline: false },
      { name: 'Taxa por entrada', value: `${(queue.settings.feeCents || 0)} centavos`, inline: true },
      { name: 'Thumbnail dos painéis auxiliares', value: `${queue.settings.banner || 'Nenhuma configurada'}`, inline: false }
    )
    .setColor(0x3498db)
    .setTimestamp();

  const queueImage = getQueueImage(queue.settings.banner);
  if (queueImage.url) embed.setThumbnail(queueImage.url);

  return embed;
};

const buildFFQueueOverviewEmbed = (queueData, guild = null) => {
  const fields = Object.entries(ffQueueTypes).map(([queueType, typeInfo]) => {
    const queue = queueData.queues?.[queueType] || { settings: getQueueSettings(queueData) };
    return {
      name: `${typeInfo.emoji} ${typeInfo.label}`,
      value: `Aposta: ${queue.settings.defaultEntryAmount} coins | Mínimo: ${queue.settings.minPlayersToStart} | Máximo: ${queue.settings.maxPlayersPerQueue}`,
      inline: false
    };
  });

  return new EmbedBuilder()
    .setTitle('🎮 Filas de Free Fire')
    .setDescription('Configure e publique as filas abaixo.')
    .addFields(...fields)
    .setColor(0x3498db)
    .setTimestamp();
};

const buildFFQueueActionButtons = (guild = null) => [
  new ActionRowBuilder().addComponents(
    ...['Mobile', 'Emulador', 'Misto'].map(queueType => {
      const typeInfo = ffQueueTypes[queueType];
      const button = new ButtonBuilder()
        .setCustomId(`ff-queue:${queueType}`)
        .setLabel(typeInfo.label)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(typeInfo.emoji);

      return button;
    })
  ),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ff-queue:publish').setLabel('Publicar filas').setStyle(ButtonStyle.Success)
  )
];

const getGuildEmojiMarkup = (guild, name) => {
  return formatQueueEmoji(guild, name);
};

const getQueueModeEmoji = (guild, queueType) => {
  if (!['Mobile', 'Emulador'].includes(queueType)) return '';
  return getGuildEmojiMarkup(guild, queueType.toLowerCase()) || ffQueueTypes[queueType].emoji;
};

const getQueueValueEmoji = guild => getGuildEmojiMarkup(guild, 'dinheiro') || '💰';

const getQueuePlayersEmoji = guild => getGuildEmojiMarkup(guild, 'aaaaapostas') || '👥';

const applyGuildEmojiToButton = (button, guild, emojiName) => {
  const emoji = getQueueEmoji(guild, emojiName);
  if (emoji) button.setEmoji(emoji);
  return button;
};

const buildReleasePixButton = (guild, disabled = false) => {
  const button = new ButtonBuilder()
    .setCustomId('aposta-liberar-pix')
    .setLabel('Liberar Pix')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  return applyGuildEmojiToButton(button, guild, 'picisi');
};

const buildQueueEntryActionRow = (queueType, mode, guild) => {
  const buttons = getQueueButtonLabels(queueType, mode).map(option => {
    const button = new ButtonBuilder()
      .setCustomId(`bet:${option.value}:${queueType}:${mode}`)
      .setLabel(option.label)
      .setStyle(ButtonStyle.Secondary);

    applyGuildEmojiToButton(button, guild, option.emoji);

    return button;
  });

  buttons.push(
    new ButtonBuilder().setCustomId(`bet:leave:${queueType}:${mode}`).setLabel('Sair').setStyle(ButtonStyle.Danger)
  );

  return new ActionRowBuilder().addComponents(...buttons);
};

const getUserRecord = userId => {
  if (!userData[userId]) {
    userData[userId] = {
      coins: 0,
      victories: 0,
      defeats: 0,
      streak: 0,
      bestStreak: 0,
      items: []
    };
  }
  return userData[userId];
};

const recordWin = (userId, awardCoins = true) => {
  const user = getUserRecord(userId);
  if (awardCoins) user.coins += 1;
  user.victories += 1;
  user.streak += 1;
  if (user.streak > user.bestStreak) user.bestStreak = user.streak;
  saveUserData(userData);
};

const recordLoss = userId => {
  const user = getUserRecord(userId);
  user.defeats += 1;
  user.streak = 0;
  saveUserData(userData);
};

const getRankingEntries = () => {
  return Object.entries(userData)
    .map(([userId, profile]) => ({
      userId,
      victories: Number(profile.victories || 0),
      defeats: Number(profile.defeats || 0),
      coins: Number(profile.coins || 0),
      streak: Number(profile.streak || 0),
      bestStreak: Number(profile.bestStreak || 0)
    }))
    .sort((a, b) => {
      if (b.victories !== a.victories) return b.victories - a.victories;
      if (b.bestStreak !== a.bestStreak) return b.bestStreak - a.bestStreak;
      return b.coins - a.coins;
    });
};

const buildRankEmbed = (entries, page, pageSize = 10, thumbnailUrl = null) => {
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageEntries = entries.slice(startIndex, startIndex + pageSize);
  const rankingLines = pageEntries.map((entry, index) => {
    const position = startIndex + index + 1;
    return `**${position}°** - <@${entry.userId}> • Pontuação: ${entry.victories}`;
  });

  const description = rankingLines.length > 0
    ? rankingLines.join('\n')
    : 'Nenhum registro de vitórias encontrado.';

  const embed = new EmbedBuilder()
    .setTitle('Ranking de Vitórias')
    .setDescription(description)
    .setFooter({ text: `Página ${currentPage} de ${totalPages}` })
    .setColor(0x3498db)
    .setTimestamp();
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  return embed;
};

const buildRankNavigationRow = (page, totalPages) => {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rank-prev:${page}`)
      .setLabel('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`rank-next:${page}`)
      .setLabel('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages)
  );
};

const buildRankPanelEmbed = (user, thumbnailUrl = null) => {
  const embed = new EmbedBuilder()
    .setTitle('Ranking Jordan')
    .setDescription('> Seja bem-vindo(a) ao painel de ranking e perfil da ORG Jordan!\n\nUse os botões abaixo para ver seu perfil ou o ranking geral.')
    .setColor(0x3498db)
    .setTimestamp();
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  return embed;
};

const buildRankPanelRow = guild => {
  return new ActionRowBuilder().addComponents(
    applyGuildEmojiToButton(
      new ButtonBuilder()
        .setCustomId('rank-panel-profile')
        .setLabel('Perfil')
        .setStyle(ButtonStyle.Secondary),
      guild,
      'astar'
    ),
    applyGuildEmojiToButton(
      new ButtonBuilder()
        .setCustomId('rank-panel-rank')
        .setLabel('Rank')
        .setStyle(ButtonStyle.Secondary),
      guild,
      'black_coroa'
    )
  );
};

const buyItem = (userId, itemKey) => {
  const user = getUserRecord(userId);
  const item = shopItems[itemKey];
  if (!item) return { success: false, error: 'item-invalido' };
  if (user.items.includes(itemKey)) return { success: false, error: 'ja-comprado' };
  if (user.coins < item.price) return { success: false, error: 'coins-insuficientes', price: item.price };
  user.coins -= item.price;
  user.items.push(itemKey);
  saveUserData(userData);
  return { success: true, item };
};

const saveTicketLog = async logData => {
  try {
    ensureDir(ticketLogsDir);
    saveJsonFile(path.join(ticketLogsDir, `${logData.ticketId}.json`), logData);

    const indexData = readJsonFile(ticketLogsIndexPath) || [];
    const filteredIndex = indexData.filter(entry => entry.ticketId !== logData.ticketId);
    filteredIndex.unshift({
      ticketId: logData.ticketId,
      channelName: logData.channelName,
      ticketType: logData.ticketType,
      ownerId: logData.ownerId,
      closedAt: logData.closedAt,
      closedById: logData.closedById
    });
    saveJsonFile(ticketLogsIndexPath, filteredIndex);
  } catch (error) {
    console.error('Erro ao salvar log do ticket:', error);
  }
};

const loadQueueLogIndex = () => {
  ensureDir(queueLogsDir);
  const data = readJsonFile(queueLogsIndexPath);
  return Array.isArray(data) ? data : [];
};

const loadQueueLogFile = queueId => {
  const filePath = path.join(queueLogsDir, `${queueId}.json`);
  return readJsonFile(filePath);
};

const findArchivedQueueLog = (entry, targetUserId) => {
  if (entry.queueId && /^\d+$/.test(entry.queueId)) {
    const queueLog = loadQueueLogFile(entry.queueId);
    const playerIds = queueLog?.threadMeta?.playerIds || [];
    return playerIds.map(String).includes(String(targetUserId)) ? queueLog : null;
  }

  const mentionedIds = new Set();
  const mentionPattern = /<@!?(\d+)>/g;
  let mention;
  while ((mention = mentionPattern.exec(entry.text)) !== null) {
    mentionedIds.add(mention[1]);
  }

  const logTime = Number(entry.timestamp);
  if (!Number.isFinite(logTime)) return null;
  const title = entry.title.toLowerCase();
  const expectedActions = title.includes('cancelada')
    ? new Set(['cancelado'])
    : title.includes('sem vencedor')
      ? new Set(['finalizado-sem-vencedor'])
      : title.includes('finalizada')
        ? new Set(['finalizado', 'resultado-excluido'])
        : null;

  const candidates = loadQueueLogIndex()
    .filter(indexEntry => {
      const playerIds = Array.isArray(indexEntry.playerIds) ? indexEntry.playerIds.map(String) : [];
      if (!playerIds.includes(String(targetUserId)) || playerIds.length === 0) return false;
      if (!playerIds.every(playerId => mentionedIds.has(playerId))) return false;

      const createdAt = new Date(indexEntry.createdAt).getTime();
      const closedAt = new Date(indexEntry.closedAt).getTime();
      if (!Number.isFinite(createdAt) || !Number.isFinite(closedAt)) return false;
      return logTime >= createdAt - 2 * 60 * 1000 && logTime <= closedAt + 2 * 60 * 1000;
    })
    .map(indexEntry => ({
      indexEntry,
      queueLog: loadQueueLogFile(indexEntry.queueId),
      distance: Math.abs(logTime - new Date(indexEntry.closedAt).getTime())
    }))
    .filter(candidate => candidate.queueLog && (
      !expectedActions || expectedActions.has(candidate.queueLog.action)
    ))
    .sort((left, right) => left.distance - right.distance);

  return candidates.length ? candidates[0].queueLog : null;
};

const saveQueueLog = async logData => {
  try {
    ensureDir(queueLogsDir);
    saveJsonFile(path.join(queueLogsDir, `${logData.queueId}.json`), logData);

    const indexData = loadQueueLogIndex();
    const filteredIndex = indexData.filter(entry => entry.queueId !== logData.queueId);
    filteredIndex.unshift({
      queueId: logData.queueId,
      channelName: logData.channelName,
      action: logData.action,
      queueType: logData.threadMeta?.queueType || 'desconhecido',
      mode: logData.threadMeta?.mode || '',
      createdAt: logData.createdAt,
      closedAt: logData.closedAt,
      closedById: logData.closedById,
      playerIds: Array.isArray(logData.threadMeta?.playerIds) ? logData.threadMeta.playerIds : []
    });
    saveJsonFile(queueLogsIndexPath, filteredIndex);
  } catch (error) {
    console.error('Erro ao salvar log da fila:', error);
  }
};

const saveQueueThreadLog = async (threadChannel, closedById, action, summary = '') => {
  if (!threadChannel || !threadChannel.id || !threadChannel.isTextBased?.()) return null;
  if (!apostaThreadMeta.has(threadChannel.id)) return null;

  const threadMeta = apostaThreadMeta.get(threadChannel.id);
  const messages = await fetchAllChannelMessages(threadChannel, null).catch(() => []);
  const logData = {
    queueId: threadChannel.id,
    channelName: threadChannel.name || '',
    guildId: threadChannel.guild?.id || '',
    createdAt: threadMeta.createdAt || threadChannel.createdAt?.toISOString() || new Date().toISOString(),
    closedAt: new Date().toISOString(),
    closedById: closedById || null,
    action,
    summary,
    threadMeta,
    messages
  };

  await saveQueueLog(logData);
  return logData;
};

const parseTicketStateFromChannel = channel => {
  if (!channel) return null;

  const ticketType = getTicketTypeForChannel(channel);
  if (isThreadChannel(channel) && ticketType) {
    const ownerId = getTicketOwnerFromThreadName(channel.name);

    return {
      ownerId,
      type: ticketType,
      assignedTo: null,
      createdAt: null,
      lastActivity: new Date().toISOString(),
      inactivity: {
        warningTimer: null,
        closeTimer: null
      }
    };
  }

  if (typeof channel.topic !== 'string') return null;
  const parts = channel.topic.split('|');
  const parsed = {};
  for (const part of parts) {
    const [key, ...rest] = part.split(':');
    if (!key || rest.length === 0) continue;
    parsed[key] = rest.join(':');
  }
  if (!parsed.ticketOwnerId) return null;
  return {
    ownerId: parsed.ticketOwnerId,
    type: parsed.ticketType || 'suporte',
    assignedTo: parsed.ticketAssignedTo || null,
    createdAt: parsed.ticketCreatedAt || null,
    lastActivity: parsed.ticketCreatedAt || new Date().toISOString(),
    inactivity: {
      warningTimer: null,
      closeTimer: null
    }
  };
};

const isThreadChannel = channel => {
  if (!channel) return false;
  if (typeof channel.isThread === 'function') return channel.isThread();
  return channel.type === ChannelType.PrivateThread || channel.type === ChannelType.PublicThread;
};

const getTicketTypeForChannel = channel => {
  const typeFromName = getTicketTypeFromChannelName(channel?.name || '');
  if (typeFromName) return typeFromName;
  if (!isThreadChannel(channel)) return null;

  const typeFromParentName = getTicketTypeFromChannelName(channel.parent?.name || '');
  if (typeFromParentName) return typeFromParentName;

  return TICKET_TYPES.find(({ value }) => {
    const envKey = getTicketChannelEnvKey(value);
    return envKey && process.env[envKey]?.trim() === channel.parentId;
  })?.value || null;
};

const isTicketChannel = channel => (
  isThreadChannel(channel)
  && (activeTickets.has(channel.id) || Boolean(parseTicketStateFromChannel(channel)))
);

const findOpenTicketForUser = async (guild, userId) => {
  for (const [ticketId, ticketState] of activeTickets) {
    if (ticketState.ownerId !== userId) continue;

    let ticketChannel = guild.channels.cache.get(ticketId);
    if (!ticketChannel) {
      try {
        ticketChannel = await guild.channels.fetch(ticketId);
      } catch (error) {
        if (error?.code === 10003) {
          activeTickets.delete(ticketId);
          continue;
        }
        console.error(`Erro ao buscar ticket aberto ${ticketId}:`, error);
        throw error;
      }
    }

    if (isThreadChannel(ticketChannel)) return ticketChannel;
    activeTickets.delete(ticketId);
  }

  let channels;
  try {
    channels = await guild.channels.fetch();
  } catch (error) {
    console.error(`Erro ao buscar canais para verificar tickets abertos de ${userId}:`, error);
    throw error;
  }

  const parentChannels = new Map();
  for (const { value: ticketType } of TICKET_TYPES) {
    const envKey = getTicketChannelEnvKey(ticketType);
    const configuredChannelId = envKey ? process.env[envKey]?.trim() : '';
    const parentChannel = findTicketParentChannel(channels, ticketType, configuredChannelId);
    if (parentChannel) parentChannels.set(parentChannel.id, parentChannel);
  }

  const ownsTicket = async thread => {
    const ownerFromName = getTicketOwnerFromThreadName(thread.name);
    if (ownerFromName) return ownerFromName === userId;
    if (!getTicketTypeForChannel(thread)) return false;

    let messages;
    try {
      messages = await thread.messages.fetch({ limit: 100, after: thread.id });
    } catch (error) {
      console.error(`Erro ao verificar o dono do ticket antigo ${thread.id}:`, error);
      throw error;
    }
    return messages.some(message => getTicketOwnerFromAnnouncement(message.content) === userId);
  };

  for (const parentChannel of parentChannels.values()) {
    let activeThreads;
    try {
      activeThreads = await parentChannel.threads.fetchActive();
    } catch (error) {
      console.error(`Erro ao verificar tickets ativos no canal ${parentChannel.id}:`, error);
      throw error;
    }
    for (const thread of activeThreads.threads.values()) {
      if (await ownsTicket(thread)) return thread;
    }
  }

  for (const parentChannel of parentChannels.values()) {
    for (const type of ['private', 'public']) {
      let archivedThreads;
      try {
        archivedThreads = await parentChannel.threads.fetchArchived({ type, fetchAll: true });
      } catch (error) {
        console.error(`Erro ao verificar tickets arquivados no canal ${parentChannel.id}:`, error);
        throw error;
      }
      for (const thread of archivedThreads.threads.values()) {
        if (await ownsTicket(thread)) return thread;
      }
    }
  }

  return null;
};

const openOrFindTicketForUser = async (interaction, ticketType) => {
  const userId = interaction.user.id;
  const pendingOpening = ticketOpeningPromises.get(userId);
  if (pendingOpening) {
    const result = await pendingOpening;
    return { ...result, alreadyOpen: Boolean(result.ticketThread) };
  }

  const opening = (async () => {
    let existingTicket = await findOpenTicketForUser(interaction.guild, userId);
    if (existingTicket) {
      if (existingTicket.archived) {
        await existingTicket.setArchived(false, 'Reaberto pelo dono para continuar o atendimento');
      }
      await existingTicket.members.add(userId);
      const ticketState = activeTickets.get(existingTicket.id) || parseTicketStateFromChannel(existingTicket);
      if (ticketState) {
        ticketState.ownerId = userId;
        activeTickets.set(existingTicket.id, ticketState);
      }
      return { ticketThread: existingTicket, alreadyOpen: true };
    }

    const parentChannel = await resolveTicketParentChannel(interaction.guild, ticketType);
    if (!parentChannel) return { ticketThread: null, alreadyOpen: false };

    const threadName = createTicketThreadName(ticketType, interaction.user.username);
    let ticketThread;
    try {
      ticketThread = await parentChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Ticket aberto por ${interaction.user.tag}`
      });
    } catch (privateThreadError) {
      console.error('Erro ao criar thread privada de ticket, tentando thread pública', privateThreadError);
      try {
        ticketThread = await parentChannel.threads.create({
          name: threadName,
          autoArchiveDuration: 1440,
          type: ChannelType.PublicThread,
          reason: `Ticket aberto por ${interaction.user.tag}`
        });
      } catch (publicThreadError) {
        console.error('Erro ao criar thread pública de ticket', publicThreadError);
        throw publicThreadError;
      }
    }

    await ticketThread.members.add(userId);
    await ticketThread.members.add(client.user.id);
    const createdAt = new Date().toISOString();
    activeTickets.set(ticketThread.id, {
      ownerId: userId,
      type: ticketType || 'suporte',
      assignedTo: null,
      createdAt,
      lastActivity: createdAt,
      inactivity: {
        warningTimer: null,
        closeTimer: null
      }
    });

    return { ticketThread, alreadyOpen: false };
  })();

  ticketOpeningPromises.set(userId, opening);
  try {
    return await opening;
  } finally {
    if (ticketOpeningPromises.get(userId) === opening) {
      ticketOpeningPromises.delete(userId);
    }
  }
};

const addUserToTicketChannel = async (channel, userId) => {
  if (!channel) return null;
  if (isThreadChannel(channel)) {
    return channel.members.add(userId);
  }
  if (channel.permissionOverwrites) {
    return channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
  }
  return null;
};

const removeUserFromTicketChannel = async (channel, userId) => {
  if (!channel) return null;
  if (isThreadChannel(channel)) {
    return channel.members.remove(userId).catch(() => null);
  }
  if (channel.permissionOverwrites) {
    return channel.permissionOverwrites.edit(userId, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false
    }).catch(() => null);
  }
  return null;
};

const deleteChannelSafely = async channel => {
  if (!channel) return null;

  if (typeof channel === 'string') {
    return null;
  }

  const isThread = typeof channel.isThread === 'function'
    ? channel.isThread()
    : [ChannelType.PrivateThread, ChannelType.PublicThread].includes(channel.type);

  if (isThread) {
    return channel.delete('Finalização do .aux').catch(() => null);
  }

  if (channel.deletable) {
    return channel.delete('Finalização do .aux').catch(() => null);
  }

  return null;
};

const fetchAllChannelMessages = async (channel, maxMessages = 1000) => {
  const messages = [];
  let lastId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const fetched = await channel.messages.fetch(options);
    if (!fetched.size) break;

    messages.push(...fetched.map(msg => ({
      id: msg.id,
      authorId: msg.author.id,
      authorTag: msg.author.tag,
      content: msg.content,
      createdAt: msg.createdAt.toISOString(),
      attachments: msg.attachments.map(att => ({
        id: att.id,
        url: att.url,
        name: att.name,
        contentType: att.contentType
      })),
      embeds: msg.embeds.map(embed => embed.toJSON())
    })));

    if (fetched.size < 100 || (maxMessages !== null && messages.length >= maxMessages)) break;
    lastId = fetched.last().id;
  }

  return messages.reverse();
};

const clearTicketInactivityTimers = ticketId => {
  const ticketData = activeTickets.get(ticketId);
  if (!ticketData || !ticketData.inactivity) return;
  if (ticketData.inactivity.warningTimer) clearTimeout(ticketData.inactivity.warningTimer);
  if (ticketData.inactivity.closeTimer) clearTimeout(ticketData.inactivity.closeTimer);
  ticketData.inactivity.warningTimer = null;
  ticketData.inactivity.closeTimer = null;
};

const scheduleTicketInactivity = async (ticketId, channel) => {
  let ticketData = activeTickets.get(ticketId);
  const fetchChannel = async () => {
    if (channel && channel.isTextBased && channel.isTextBased()) return channel;
    return await client.channels.fetch(ticketId).catch(() => null);
  };

  const ticketChannel = await fetchChannel();
  if (!ticketChannel || !ticketChannel.isTextBased()) return;

  if (!ticketData) {
    ticketData = parseTicketStateFromChannel(ticketChannel);
    if (!ticketData) return;
    activeTickets.set(ticketId, ticketData);
  }

  clearTicketInactivityTimers(ticketId);
  ticketData.inactivity = ticketData.inactivity || {};
  ticketData.lastActivity = new Date().toISOString();
};

const finalizeTicket = async (channel, closedById, closedByTag, autoClose = false) => {
  if (!channel || !channel.isTextBased()) return;
  let ticketState = activeTickets.get(channel.id);
  if (!ticketState) {
    ticketState = parseTicketStateFromChannel(channel);
    if (!ticketState) return;
  }

  clearTicketInactivityTimers(channel.id);

  const closedAt = new Date();
  if (!ticketLogsChannelId) {
    console.warn('Aviso: canal de logs de tickets não está configurado.');
  }
  await sendLogEmbed(channel.guild, ticketLogsChannelId, autoClose ? 'Ticket fechado automaticamente' : 'Ticket finalizado',
    `Canal: ${channel.name}\nFinalizado por: ${closedByTag || (autoClose ? 'Sistema' : 'Desconhecido')}\nDono do ticket: ${ticketState.ownerId ? `<@${ticketState.ownerId}>` : 'Desconhecido'}\nAssumido por: ${ticketState.assignedTo ? `<@${ticketState.assignedTo}>` : 'Ninguém'}\nFechado em: ${closedAt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })}`
  );

  const ticketMessages = await fetchAllChannelMessages(channel).catch(error => {
    console.error('Erro ao buscar mensagens do ticket para log:', error);
    return [];
  });

  const logData = {
    ticketId: channel.id,
    channelName: channel.name,
    ticketType: ticketState.type || 'suporte',
    ownerId: ticketState.ownerId || null,
    assignedTo: ticketState.assignedTo || null,
    createdAt: ticketState.createdAt || null,
    closedAt: new Date().toISOString(),
    closedById: closedById || null,
    closedByTag: closedByTag || (autoClose ? 'Sistema' : null),
    messages: ticketMessages
  };

  await saveTicketLog(logData);

  const ticketLogPath = path.join(ticketLogsDir, `${logData.ticketId}.json`);
  if (ticketLogsChannelId && fs.existsSync(ticketLogPath)) {
    try {
      const ticketLogAttachment = new AttachmentBuilder(ticketLogPath, { name: `${channel.name}-log.json` });
      await sendLogEmbed(channel.guild, ticketLogsChannelId,
        autoClose ? 'Ticket fechado automaticamente' : 'Ticket finalizado',
        `Canal: ${channel.name}\nFinalizado por: ${closedByTag || (autoClose ? 'Sistema' : 'Desconhecido')}\nDono do ticket: ${ticketState.ownerId ? `<@${ticketState.ownerId}>` : 'Desconhecido'}\nAssumido por: ${ticketState.assignedTo ? `<@${ticketState.assignedTo}>` : 'Ninguém'}\nFechado em: ${closedAt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })}\nArquivo de log: ${channel.name}-log.json`,
        0xffffff,
        'tickets'
      );
      await channel.guild.channels.fetch(ticketLogsChannelId).then(logChannel => {
        if (logChannel && logChannel.isTextBased?.()) {
          return logChannel.send({ files: [ticketLogAttachment] }).catch(() => null);
        }
        return null;
      }).catch(() => null);
    } catch (error) {
      console.error('Erro ao anexar log de ticket no canal de logs:', error);
    }
  }

  activeTickets.delete(channel.id);
  setTimeout(() => {
    channel.delete('Ticket finalizado').catch(() => null);
  }, 5000);
};

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  }
}

const registerSlashCommands = async () => {
  if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID || !primaryGuildId) {
    console.warn('Variáveis de ambiente ausentes para registrar comandos slash.');
    return;
  }

  try {
    const primaryGuild = client.guilds.cache.get(primaryGuildId)
      || await client.guilds.fetch(primaryGuildId);
    if (!primaryGuild) {
      console.error(`Não foi possível localizar o servidor principal ${primaryGuildId}.`);
      return;
    }

    if (client.user.id !== process.env.CLIENT_ID) {
      console.error(`CLIENT_ID (${process.env.CLIENT_ID}) não corresponde ao usuário do bot (${client.user.id}).`);
      return;
    }

    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    const commands = Array.from(client.commands.values()).map(command => command.data.toJSON());

    console.log('Registrando comandos slash...');
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, primaryGuild.id),
      { body: commands }
    );
    console.log('Comandos slash registrados com sucesso.');
  } catch (error) {
    if (error?.code === 50001 || error?.status === 403) {
      console.error(
        `Discord negou acesso ao registrar comandos no servidor ${primaryGuildId}. ` +
        'Confirme que o bot está nesse servidor e que foi instalado com o escopo applications.commands.',
        error?.rawError || error
      );
      return;
    }
    console.error('Erro ao registrar comandos slash:', error?.status, error?.code, error?.rawError || error);
  }
};

const leaveUnauthorizedGuild = guild => {
  if (guild.id === primaryGuildId) return Promise.resolve();

  const pendingLeave = pendingGuildLeaves.get(guild.id);
  if (pendingLeave) return pendingLeave;

  const leave = guild.leave()
    .then(() => {
      console.log(`Saí do servidor não autorizado ${guild.id}.`);
    })
    .catch(error => {
      console.error(`Não foi possível sair do servidor não autorizado ${guild.id}:`, error);
    })
    .finally(() => {
      pendingGuildLeaves.delete(guild.id);
    });

  pendingGuildLeaves.set(guild.id, leave);
  return leave;
};

client.on(Events.GuildCreate, leaveUnauthorizedGuild);

client.once(Events.ClientReady, async () => {
  console.log(`Bot pronto: ${client.user.tag}`);
  console.log('client.user.id =', client.user.id, 'CLIENT_ID=', process.env.CLIENT_ID);
  console.log('Guild em cache?', client.guilds.cache.has(primaryGuildId));
  await Promise.all(
    Array.from(client.guilds.cache.values(), leaveUnauthorizedGuild)
  );
  await registerSlashCommands();

  if (ticketCategoryId) {
    const category = await client.channels.fetch(ticketCategoryId).catch(() => null);
    if (category?.type === ChannelType.GuildCategory) {
      for (const channel of category.children.cache.values()) {
        if (channel.type !== ChannelType.GuildText) continue;
        const ticketState = parseTicketStateFromChannel(channel);
        if (!ticketState) continue;
        activeTickets.set(channel.id, ticketState);
        await scheduleTicketInactivity(channel.id, channel).catch(() => null);
      }
    }
  }
});

const restoreBetThreadMeta = async threadChannel => {
  if (!threadChannel?.isThread?.() || threadChannel.parentId !== apostasChannelId) return null;
  if (unavailableBetStarterMessageIds.has(threadChannel.id)) return null;

  let starterMessage;
  try {
    starterMessage = await threadChannel.fetchStarterMessage();
  } catch (error) {
    if (error?.code === 10008) {
      unavailableBetStarterMessageIds.add(threadChannel.id);
      console.warn(`A mensagem inicial da aposta ${threadChannel.id} não existe mais; não foi possível restaurar os dados da aposta.`);
      return null;
    }
    console.error(`Erro ao recuperar a mensagem inicial da aposta ${threadChannel.id}:`, error);
    return null;
  }
  if (!starterMessage) return null;

  const queueName = parseQueueThreadName(threadChannel.name);
  const starterEmbed = starterMessage.embeds.find(embed => (
    (embed.fields || []).some(field => /jogadores?/i.test(String(field.name || '')))
  ));
  const parsedPlayers = parseQueuePlayersFromEmbed(starterEmbed);
  const playerIds = parsedPlayers.map(player => player.id);
  if (playerIds.length !== 2) return null;

  const initialMentions = extractMentionedUserIds((starterMessage.content || '').split('|')[0]);
  const mediatorId = initialMentions.length > playerIds.length
    ? initialMentions[playerIds.length]
    : null;

  let pixReleased = false;
  let resultRecorded = false;
  try {
    const messages = await fetchAllChannelMessages(threadChannel, 1000);
    pixReleased = messages.some(message => message.embeds.some(embed => embed.title === 'QR Code Pix'));
    resultRecorded = hasRecordedBetResult(messages);
  } catch (error) {
    console.error(`Erro ao recuperar o histórico da aposta ${threadChannel.id}:`, error);
    return null;
  }

  const betValue = starterMessage.embeds
    .flatMap(embed => embed.fields || [])
    .find(field => field.name.includes('Valor'))?.value;
  const threadMeta = {
    selectedBetType: queueName?.betType || null,
    queueNumber: queueName?.queueNumber,
    playerIds,
    playerNames: parsedPlayers.map(player => player.label),
    pixReleased,
    resultRecorded,
    betCents: parseCurrencyToCents(betValue)
  };

  apostaThreadMeta.set(threadChannel.id, threadMeta);
  if (mediatorId) assignedBetAdministrators.set(threadChannel.id, mediatorId);
  return threadMeta;
};

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction, {
        supportRoleIds,
        ticketCategoryId,
        activeTickets,
        logsChannelId,
        buildTicketPanelPayload,
        hasQueueLogAccess,
        findQueueLogsForUser,
        buildQueueLogDetail,
        queueLogSelections,
        logChannels,
        logChannelOverrides,
        canConfigureLogChannels
      });
      return;
    }

    if (!interaction.guild) return;

    const sendTicketLog = async (title, description) => {
      if (!interaction.guild) return;
      await sendLogEmbed(interaction.guild, ticketLogsChannelId, title, description);
    };

    if (interaction.isChannelSelectMenu()) {
      const customId = interaction.customId ?? '';
      if (!customId.startsWith('logs-config-channel:')) return;
      if (!canConfigureLogChannels(interaction.member, interaction.user.id, interaction.memberPermissions)) {
        await interaction.reply({
          content: 'Apenas o owner ou administradores podem configurar os canais de logs.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const key = customId.slice('logs-config-channel:'.length);
      const definition = LOG_CHANNEL_DEFINITIONS.find(item => item.key === key);
      const channelId = interaction.values[0];
      if (!definition || !channelId) {
        await interaction.reply({ content: 'Seleção de canal inválida. Abra `/logs` novamente.', flags: MessageFlags.Ephemeral });
        return;
      }

      let selectedChannel;
      try {
        selectedChannel = await interaction.guild.channels.fetch(channelId);
      } catch (error) {
        console.error(`Erro ao validar canal selecionado para ${key}:`, error);
        await interaction.reply({ content: 'Não consegui acessar o canal selecionado. Confira as permissões do bot.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'Selecione um canal de texto deste servidor.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        configureLogChannel(key, selectedChannel.id);
      } catch (error) {
        console.error(`Erro ao salvar o canal de logs ${key}:`, error);
        await interaction.reply({ content: 'Não consegui salvar a configuração dos canais de logs.', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.update(buildLogConfigPanel(logChannels, logChannelOverrides, key));
      return;
    }

    if (interaction.isUserSelectMenu()) {
      if (interaction.customId !== 'mediador-pix-admin-select') return;

      const canViewAllPix = isOwnerAccess(interaction.guild, interaction.user.id)
        || hasQueueManagerRole(interaction.member);
      if (!canViewAllPix) {
        await interaction.reply({
          content: 'Apenas a administração autorizada pode verificar cadastros Pix.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const selectedUserId = interaction.values[0];
      const pixData = mediadorPixData.get(selectedUserId);
      if (!pixData) {
        await interaction.update({
          content: 'Esse mediador ainda não cadastrou os dados do Pix.',
          embeds: [],
          components: []
        });
        return;
      }

      const pixEmbed = new EmbedBuilder()
        .setTitle('Cadastro Pix do mediador')
        .setDescription(`Mediador: <@${selectedUserId}>`)
        .setColor(0xffeb3b)
        .addFields(
          { name: 'Nome', value: pixData.bankName || 'Não informado', inline: false },
          { name: 'Chave', value: pixData.pixKey || 'Não informada', inline: false }
        );
      await interaction.update({
        content: '',
        embeds: [pixEmbed],
        components: [],
        allowedMentions: { parse: [] }
      });
      return;
    }

    if (interaction.isRoleSelectMenu()) {
      if (interaction.customId !== 'autorole-roles') return;
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({ content: 'Você precisa da permissão de Gerenciar Servidor para configurar auto role.', flags: MessageFlags.Ephemeral });
        return;
      }

      autoroleRoles.set(interaction.guild.id, interaction.values);
      saveAutoroleConfig();

      const selectedRoles = interaction.values.map(roleId => `<@&${roleId}>`).join(', ');
      await interaction.reply({ content: `✅ Auto role atualizado para: ${selectedRoles}`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId ?? '';
      const messageId = interaction.message.id;

      if (customId === 'logs-config-category') {
        if (!canConfigureLogChannels(interaction.member, interaction.user.id, interaction.memberPermissions)) {
          await interaction.reply({
            content: 'Apenas o owner ou administradores podem configurar os canais de logs.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        const key = interaction.values[0];
        if (!LOG_CHANNEL_DEFINITIONS.some(definition => definition.key === key)) {
          await interaction.reply({ content: 'Tipo de log inválido. Abra `/logs` novamente.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.update(buildLogConfigPanel(logChannels, logChannelOverrides, key));
        return;
      }

      if (customId === 'user-logs-queue-select' || customId === 'user-logs-ticket-select') {
        const selection = userLogQuerySelections.get(messageId);
        if (!selection) {
          await interaction.reply({ content: 'Esta consulta de logs expirou. Use `.logs @usuario` novamente.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (selection.requesterId !== interaction.user.id || !hasQueueLogAccess(interaction.member, interaction.user.id)) {
          await interaction.reply({ content: 'Somente quem abriu a consulta, com permissão de suporte, pode selecionar e publicar estes logs.', flags: MessageFlags.Ephemeral });
          return;
        }

        const selectedValue = interaction.values[0];
        if (customId === 'user-logs-queue-select') {
          const entry = selection.queueEntries?.find(item => item.messageId === selectedValue);
          if (!entry) {
            await interaction.reply({ content: 'Não encontrei essa fila na consulta. Volte e tente novamente.', flags: MessageFlags.Ephemeral });
            return;
          }

          const queueLog = entry.queueId
            ? loadQueueLogFile(entry.queueId)
            : findArchivedQueueLog(entry, selection.targetUserId);
          if (queueLog && !(queueLog.threadMeta?.playerIds || []).map(String).includes(String(selection.targetUserId))) {
            await interaction.reply({ content: 'Este registro não pertence ao usuário consultado.', flags: MessageFlags.Ephemeral });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle(entry.title)
            .setDescription(entry.text.slice(0, 4000))
            .setColor(entry.title.toLocaleLowerCase('pt-BR').includes('cancelad') ? 0xff6b6b : 0x3498db)
            .setTimestamp(new Date(entry.timestamp));
          const files = [];
          if (queueLog) {
            const transcript = buildQueueTranscriptHtml(queueLog);
            files.push(new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
              name: `fila-${queueLog.queueId}.html`,
              description: 'Transcrição arquivada da fila'
            }));
          }

          await interaction.deferUpdate();
          try {
            await interaction.channel.send({
              content: `Log da fila de <@${selection.targetUserId}> selecionado por <@${interaction.user.id}>:`,
              embeds: [embed],
              files,
              allowedMentions: { parse: [] }
            });
            await interaction.message.edit({
              embeds: [new EmbedBuilder()
                .setTitle('Log publicado')
                .setDescription(`O log de fila de <@${selection.targetUserId}> foi enviado neste canal.`)
                .setColor(0x2ecc71)
                .setTimestamp()],
              components: []
            });
            userLogQuerySelections.delete(messageId);
          } catch (error) {
            console.error('Erro ao publicar log de fila selecionado:', error);
            await interaction.followUp({ content: 'Não consegui publicar este log no canal.', flags: MessageFlags.Ephemeral });
          }
          return;
        }

        const ticketEntry = selection.ticketEntries?.find(item => item.ticketId === selectedValue);
        const ticketLog = ticketEntry ? loadTicketLog(ticketEntry.ticketId) : null;
        if (!ticketEntry || !ticketLog || String(ticketLog.ownerId) !== String(selection.targetUserId)) {
          await interaction.reply({ content: 'Não encontrei o histórico deste ticket para o usuário consultado.', flags: MessageFlags.Ephemeral });
          return;
        }

        const ticketEmbed = new EmbedBuilder()
          .setTitle(`Histórico do ticket ${ticketLog.channelName || ticketLog.ticketId}`)
          .setDescription(`Transcrição completa anexada. Dono: <@${ticketLog.ownerId}>`)
          .addFields(
            { name: 'Tipo', value: String(ticketLog.ticketType || 'Não informado'), inline: true },
            { name: 'Assumido por', value: ticketLog.assignedTo ? `<@${ticketLog.assignedTo}>` : 'Ninguém', inline: true },
            { name: 'Finalizado por', value: ticketLog.closedById ? `<@${ticketLog.closedById}>` : String(ticketLog.closedByTag || 'Não informado'), inline: true },
            { name: 'Criado em', value: ticketLog.createdAt ? new Date(ticketLog.createdAt).toLocaleString('pt-BR') : 'Não informado', inline: true },
            { name: 'Finalizado em', value: ticketLog.closedAt ? new Date(ticketLog.closedAt).toLocaleString('pt-BR') : 'Não informado', inline: true }
          )
          .setColor(0x3498db)
          .setTimestamp();
        const ticketAttachment = new AttachmentBuilder(
          Buffer.from(formatTicketLogText(ticketLog), 'utf8'),
          { name: `ticket-${ticketLog.ticketId}.txt`, description: 'Transcrição do ticket' }
        );

        await interaction.deferUpdate();
        try {
          await interaction.channel.send({
            content: `Log do ticket de <@${selection.targetUserId}> selecionado por <@${interaction.user.id}>:`,
            embeds: [ticketEmbed],
            files: [ticketAttachment],
            allowedMentions: { parse: [] }
          });
          await interaction.message.edit({
            embeds: [new EmbedBuilder()
              .setTitle('Log publicado')
              .setDescription(`O log do ticket de <@${selection.targetUserId}> foi enviado neste canal.`)
              .setColor(0x2ecc71)
              .setTimestamp()],
            components: []
          });
          userLogQuerySelections.delete(messageId);
        } catch (error) {
          console.error('Erro ao publicar log de ticket selecionado:', error);
          await interaction.followUp({ content: 'Não consegui publicar este log no canal.', flags: MessageFlags.Ephemeral });
        }
        return;
      }

      if (customId.startsWith('mediador-manage-select:')) {
        if (!canManageMediadorQueue(interaction.guild, interaction.member, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas donos e suportes podem gerenciar os mediadores.', flags: MessageFlags.Ephemeral });
          return;
        }

        const [, panelChannelId, panelMessageId, offsetRaw] = customId.split(':');
        const offset = Number(offsetRaw);
        const queueUserId = interaction.values?.[0];
        if (!panelChannelId || !panelMessageId || !Number.isInteger(offset) || !queueUserId) {
          await interaction.reply({ content: 'Não foi possível processar essa opção. Abra o gerenciamento novamente.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferUpdate();
        const queueIndex = mediadorControlQueue.indexOf(queueUserId);
        if (queueIndex === -1) {
          await interaction.editReply(await buildMediadorManageMessage(
            interaction.guild,
            panelChannelId,
            panelMessageId,
            offset,
            'Esse mediador já não está na fila.'
          ));
          return;
        }

        mediadorControlQueue.splice(queueIndex, 1);
        if (!saveMediadorControlQueueState()) {
          mediadorControlQueue.splice(queueIndex, 0, queueUserId);
          await interaction.editReply(await buildMediadorManageMessage(
            interaction.guild,
            panelChannelId,
            panelMessageId,
            offset,
            'Não foi possível salvar a alteração. A fila não foi modificada.'
          ));
          return;
        }
        const mediatorSession = stopMediadorQueueSessionForUser(queueUserId);
        await sendLogEmbed(
          interaction.guild,
          mediatorLogsChannelId,
          'Mediador removido da fila de controle',
          `Mediador: <@${queueUserId}>\nRemovido por: <@${interaction.user.id}>\n${buildMediadorSessionLogDetails(mediatorSession)}`,
          0xff6b6b,
          'mediadores'
        );

        let panelUpdateError = false;
        try {
          const panelChannel = await interaction.guild.channels.fetch(panelChannelId);
          if (!panelChannel?.isTextBased() || !panelChannel.messages?.fetch) {
            throw new Error('Canal do painel inválido ou não textual.');
          }
          const panelMessage = await panelChannel.messages.fetch(panelMessageId);
          const panelEmbed = buildMediadorPanelEmbed();
          const oldEmbed = panelMessage.embeds?.[0];
          if (oldEmbed?.image?.url) panelEmbed.setImage(oldEmbed.image.url);
          await panelMessage.edit({ embeds: [panelEmbed], components: [buildMediadorActionRow()] });
        } catch (error) {
          panelUpdateError = true;
          console.error('Erro ao atualizar o painel público da fila de mediadores:', error);
        }

        await interaction.editReply(await buildMediadorManageMessage(
          interaction.guild,
          panelChannelId,
          panelMessageId,
          offset,
          panelUpdateError
            ? `<@${queueUserId}> foi removido, mas não foi possível atualizar o painel público.`
            : `<@${queueUserId}> foi removido da fila.`
        ));
        return;
      }

      if (customId === 'logs-select' || customId.startsWith('logs-select:')) {
        const selectionData = queueLogSelections.get(interaction.message.id);
        if (!selectionData) {
          await interaction.reply({ content: 'Não foi possível encontrar os logs selecionados. Tente novamente.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!hasQueueLogAccess(interaction.member, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas o suporte e o owner configurado podem usar este seletor de logs.', flags: MessageFlags.Ephemeral });
          return;
        }

        const selectedMessageId = interaction.values[0];
        const entry = selectionData.entries.find(item => item.messageId === selectedMessageId);
        if (!entry) {
          await interaction.reply({ content: 'Entrada de log inválida. Tente novamente.', flags: MessageFlags.Ephemeral });
          return;
        }

        selectionData.index = selectionData.entries.indexOf(entry);
        const detail = buildQueueLogDetail(selectionData.targetUserId, entry, selectionData.index, selectionData.entries.length);
        await interaction.update({ embeds: [detail.embed], components: detail.components });
        return;
      }

      if (customId === 'ticket-select') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const ticketType = interaction.values[0];
        const ticketTypeLabel = getTicketTypeLabel(ticketType);

        let openResult;
        try {
          openResult = await openOrFindTicketForUser(interaction, ticketType);
        } catch (error) {
          console.error(`Erro ao verificar ou abrir ticket do tipo ${ticketType}:`, error);
          await interaction.editReply({ content: 'Não consegui verificar ou abrir seu ticket. Tente novamente em instantes.' });
          return;
        }
        if (openResult.alreadyOpen) {
          await interaction.editReply({ content: `Você já tem um ticket aberto: ${openResult.ticketThread}. Continue seu atendimento por lá.` });
          return;
        }
        if (!openResult.ticketThread) {
          const channelName = getTicketChannelName(ticketType);
          await interaction.editReply({
            content: channelName
              ? `Não encontrei o canal de texto #${channelName}. Crie esse canal para receber tickets dessa opção.`
              : 'Esta opção de atendimento não é válida.'
          });
          return;
        }

        const ticketThread = openResult.ticketThread;

        const ticketStaffRoleIds = getTicketStaffRoleIds(ticketType, supportRoleIds, filasRoleIds);
        const supportMemberIds = new Set();
        await fetchGuildMembers(interaction.guild);
        for (const roleId of ticketStaffRoleIds) {
          const role = interaction.guild.roles.cache.get(roleId);
          if (!role) continue;
          for (const member of role.members.values()) {
            if (member.user.bot) continue;
            supportMemberIds.add(member.id);
          }
        }
        for (const memberId of supportMemberIds) {
          await ticketThread.members.add(memberId).catch(error => {
            console.error(`Erro ao adicionar membro de suporte ${memberId} ao ticket:`, error);
          });
        }

        const requesterMention = `<@${interaction.user.id}>`;
        const ticketEmbed = new EmbedBuilder()
          .setTitle('Ticket aberto')
          .setDescription(`Olá ${requesterMention}, este é o seu ticket de **${ticketTypeLabel}**. Use os botões abaixo para gerenciar o atendimento.`)
          .setColor(0x3498db)
          .addFields(
            { name: 'Tipo', value: ticketTypeLabel, inline: true },
            { name: 'Assumido por', value: 'Ninguém', inline: true },
            { name: 'Dono do ticket', value: requesterMention, inline: true },
            { name: 'Tópico', value: `${ticketThread}`, inline: false }
          );

        const ticketStaffMentions = ticketStaffRoleIds.length > 0 ? ticketStaffRoleIds.map(roleId => `<@&${roleId}>`).join(' ') : 'Nenhum cargo responsável configurado.';
        const ticketMessageContent = `**🔔 Novo ticket aberto por** ${requesterMention}\n**Responsáveis:** ${ticketStaffMentions}\n**Tópico:** ${ticketThread}`;

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket-assume').setLabel('Assumir').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('ticket-leave').setLabel('Sair').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('ticket-add').setLabel('Adicionar').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('ticket-rename').setLabel('Renomear').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('ticket-close').setLabel('Finalizar').setStyle(ButtonStyle.Danger)
        );

        const mentionedUsers = [interaction.user.id].filter(Boolean);
        const uniqueUsers = [...new Set(mentionedUsers)];

        await ticketThread.send({
          content: ticketMessageContent,
          embeds: [ticketEmbed],
          components: [buttons],
          allowedMentions: {
            parse: [],
            users: uniqueUsers,
            roles: []
          }
        });

        if (ticketType === 'vaga-mediador') {
          const pixQrReply = await buildPixQrReply('24993046468', undefined, 'Guilherme da Silva Souza');
          await ticketThread.send({ files: pixQrReply.files });
          await ticketThread.send({
            content: [
              '**VAGAS JORDAN**',
              '**Suporte: R$ 5,00**',
              '**Mediador: R$ 3,00**',
              'Faça o pagamento de acordo com o cargo selecionado.',
              'Chave Pix: `24993046468`',
              'Nome: **Guilherme da Silva Souza**',
              'Envie o comprovante aqui no ticket e aguarde o atendimento.'
            ].join('\n'),
          });
        }

        if (ticketLogsChannelId) {
          await sendLogEmbed(
            interaction.guild,
            ticketLogsChannelId,
            'Ticket aberto',
            `Ticket criado por: <@${interaction.user.id}>
Tipo: ${ticketTypeLabel}
Canal: ${ticketThread}
Dono do ticket: <@${interaction.user.id}>`,
            0xffffff,
            'tickets'
          );
        }

        await scheduleTicketInactivity(ticketThread.id, ticketThread);

        await interaction.editReply({ content: `✅ Ticket criado: ${ticketThread}` });
        return;
      }

      if (customId === 'ff-select-model') {
        const model = interaction.values[0];
        const queueData = getGuildFFQueue(interaction.guild.id);
        const embed = buildFFQueueConfigEmbed(queueData, model, interaction.guild);
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      if (customId === 'aux-action-select') {
        const selection = auxSelections.get(messageId);
        if (!selection || !Array.isArray(selection.participants)) {
          await interaction.reply({ content: 'Essa seleção já expirou ou não está mais disponível.', flags: MessageFlags.Ephemeral });
          return;
        }

        const action = interaction.values[0];
        selection.action = action;
        auxSelections.set(messageId, selection);

        if (action === 'revanche') {
          const embed = EmbedBuilder.from(interaction.message.embeds[0]);
          embed.setFields({ name: 'Status', value: '<:alerta:> Revanche em breve.', inline: false });
          await interaction.update({ embeds: [embed], components: [] });
          auxSelections.delete(messageId);
          return;
        }

        if (action === 'finalizar') {
          const embed = EmbedBuilder.from(interaction.message.embeds[0]);
          embed.setFields({ name: 'Status', value: '🛑 Finalizando aposta...', inline: false });
          await interaction.update({ embeds: [embed], components: [] });

          const playerMentions = (selection.participants || []).map(id => `<@${id}>`).join(' e ') || 'Não informado';
          if (interaction.guild) {
            await sendBetResultLogs(
              interaction.guild,
              'Aposta finalizada sem vencedor',
              `Jogadores: ${playerMentions}\nMediador: ${mediadorId ? `<@${mediadorId}>` : 'Não informado'}`,
              0xffd166,
              selection.targetChannelId || interaction.channelId,
              false
            );
          }

          const targetChannel = await interaction.guild.channels.fetch(selection.targetChannelId || interaction.channelId).catch(() => interaction.channel || interaction.message?.channel);
          setTimeout(async () => {
            try {
              await saveQueueThreadLog(
                targetChannel,
                interaction.user.id,
                'finalizado-sem-vencedor',
                'Aposta finalizada sem vencedor.'
              ).catch(error => {
                console.error('Erro ao salvar log da aposta finalizada sem vencedor:', error);
              });
              await deleteChannelSafely(targetChannel);
            } catch (error) {
              console.error('Erro ao excluir tópico após finalizar aposta:', error);
            } finally {
              auxSelections.delete(messageId);
            }
          }, 3000);
          return;
        }

        const participantOptions = (selection.participantNames || selection.participants).map((participant, index) => {
          const id = selection.participants[index];
          return {
            label: String(participant),
            value: id,
            description: 'Selecionar vencedor'
          };
        });

        const winnerMenu = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('aux-select-result')
            .setPlaceholder(action === 'wo' ? 'Selecione o vencedor por W.O' : 'Selecione o vencedor')
            .addOptions(participantOptions)
        );

        const embed = EmbedBuilder.from(interaction.message.embeds[0]);
        embed.setFields({
          name: 'Status',
          value: action === 'wo' ? '<:alerta:> Selecione o vencedor por W.O.' : '✅ Selecione o vencedor da aposta.',
          inline: false
        });
        await interaction.update({ embeds: [embed], components: [winnerMenu] });
        return;
      }

      if (customId === 'aux-select-result') {
        const selectedId = interaction.values[0];
        const selection = auxSelections.get(messageId);

        if (!selection || !Array.isArray(selection.participants)) {
          await interaction.reply({ content: 'Essa seleção já expirou ou não está mais disponível.', flags: MessageFlags.Ephemeral });
          return;
        }

        const loserId = selection.participants.find(id => id !== selectedId);
        if (!loserId) {
          await interaction.reply({ content: 'Não foi possível completar a seleção.', flags: MessageFlags.Ephemeral });
          return;
        }

        const resultThreadMeta = apostaThreadMeta.get(selection.targetChannelId || interaction.channelId);
        if (resultThreadMeta?.resultRecorded) {
          await interaction.reply({ content: 'O resultado desta aposta já foi registrado.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (resultThreadMeta) {
          resultThreadMeta.resultRecorded = true;
          resultThreadMeta.resultType = selection.action === 'wo' ? 'wo' : 'normal';
          apostaThreadMeta.set(selection.targetChannelId || interaction.channelId, resultThreadMeta);
        }

        const winner = await client.users.fetch(selectedId).catch(() => null);
        const loser = await client.users.fetch(loserId).catch(() => null);
        const awardCoins = selection.action !== 'wo';
        recordWin(selectedId, awardCoins);
        recordLoss(loserId);

        const mediadorId = assignedBetAdministrators.get(interaction.channelId) || null;
        if (mediadorId) {
          const mediadorStats = mediadorProfile.getMediadorProfileStats(mediadorId);
          mediadorProfile.recordMediadorCompletedQueue(mediadorStats);
        }

        const embed = EmbedBuilder.from(interaction.message.embeds[0]);
        const statusText = awardCoins
          ? `✅ Seleção concluída: ${winner?.username || 'Desconhecido'} venceu e ganhou 1 coin.`
          : `✅ Seleção concluída: ${winner?.username || 'Desconhecido'} venceu por W.O e não ganhou coin.`;
        embed.setFields({ name: 'Status', value: statusText, inline: false });
        await interaction.update({ embeds: [embed], components: [] });

        const resultEmbed = new EmbedBuilder()
          .setTitle(`🎉 Resultado do ${selection.commandLabel || '.aux'}`)
          .setDescription(`Vencedor: ${winner}\nPerdedor: ${loser}`)
          .addFields(
            { name: 'Vencedor', value: `${winner}${awardCoins ? ' +1 vitória e 1 coin' : ' +1 vitória'}`, inline: true },
            { name: 'Perdedor', value: `${loser} +1 derrota`, inline: true }
          )
          .setColor(0x3498db)
          .setTimestamp();

        if (interaction.guild) {
          await sendBetResultLogs(
            interaction.guild,
            'Aposta finalizada',
            `Vencedor: <@${selectedId}>\nPerdedor: <@${loserId}>\nMediador: ${mediadorId ? `<@${mediadorId}>` : 'Não informado'}`,
            0xffffff,
            selection.targetChannelId || interaction.channelId,
            true
          );
        }

        const finalButtonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('aux-finalizar-aposta')
            .setLabel('Finalizar aposta')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.message.reply({ embeds: [resultEmbed], components: [finalButtonRow] });
        auxSelections.delete(messageId);
        return;
      }

      if (customId === 'loja-select-role') {
        const roleId = interaction.values[0];
        const roleData = lojaRoles[roleId];

        if (!roleData) {
          await interaction.reply({ content: 'Cargo não disponível.', flags: MessageFlags.Ephemeral });
          return;
        }

        const user = getUserRecord(interaction.user.id);
        if (user.coins < roleData.price) {
          await interaction.reply({ content: `❌ Você não tem coins suficientes! Precisa de ${roleData.price} coins e você tem ${user.coins}.`, flags: MessageFlags.Ephemeral });
          return;
        }

        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          await interaction.reply({ content: 'Cargo não encontrado no servidor.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (interaction.member.roles.cache.has(roleId)) {
          await interaction.reply({ content: '❌ Você já possui este cargo.', flags: MessageFlags.Ephemeral });
          return;
        }

        const botMember = interaction.guild.members.me;
        if (role.managed
          || !botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)
          || botMember.roles.highest.comparePositionTo(role) <= 0) {
          await interaction.reply({
            content: 'Não consigo entregar esse cargo. Um administrador precisa conceder Gerenciar cargos ao bot e deixar o cargo do bot acima do cargo da loja na hierarquia do servidor.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        try {
          await interaction.member.roles.add(role);
          user.coins -= roleData.price;
          saveUserData(userData);

          const sucessEmbed = new EmbedBuilder()
            .setTitle('✅ Cargo Comprado!')
            .setDescription(`Você comprou o cargo ${roleData.name} por ${roleData.price} coins.`)
            .addFields(
              { name: 'Coins restantes', value: `${user.coins}`, inline: true }
            )
            .setColor(0x3498db)
            .setTimestamp();

          await interaction.reply({ embeds: [sucessEmbed], flags: MessageFlags.Ephemeral });

          const embed = EmbedBuilder.from(interaction.message.embeds[0]);
          embed.setFields({ name: 'Seus coins', value: `${user.coins}`, inline: false });
          await interaction.message.edit({ embeds: [embed] });
        } catch (error) {
          console.error(`Erro ao adicionar o cargo ${role.id} ao usuário ${interaction.user.id}:`, error);
          const message = error?.code === 50013
            ? 'O Discord recusou a entrega do cargo. Peça a um administrador para conferir a permissão Gerenciar cargos e a hierarquia do bot.'
            : 'Erro ao adicionar o cargo. Tente novamente mais tarde.';
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
        return;
      }
    }

    if (interaction.isButton()) {
      const customId = interaction.customId ?? '';

      if (customId.startsWith('logs-config-reset:')) {
        if (!canConfigureLogChannels(interaction.member, interaction.user.id, interaction.memberPermissions)) {
          await interaction.reply({
            content: 'Apenas o owner ou administradores podem configurar os canais de logs.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        const key = customId.slice('logs-config-reset:'.length);
        if (!LOG_CHANNEL_DEFINITIONS.some(definition => definition.key === key)) {
          await interaction.reply({ content: 'Tipo de log inválido. Abra `/logs` novamente.', flags: MessageFlags.Ephemeral });
          return;
        }
        try {
          resetLogChannel(key);
        } catch (error) {
          console.error(`Erro ao restaurar o canal padrão de logs ${key}:`, error);
          await interaction.reply({ content: 'Não consegui restaurar a configuração anterior.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.update(buildLogConfigPanel(logChannels, logChannelOverrides, key));
        return;
      }

      if (customId.startsWith('user-logs:')) {
        const selection = userLogQuerySelections.get(interaction.message.id);
        if (!selection) {
          await interaction.reply({ content: 'Esta consulta de logs expirou. Use `.logs @usuario` novamente.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (selection.requesterId !== interaction.user.id || !hasQueueLogAccess(interaction.member, interaction.user.id)) {
          await interaction.reply({ content: 'Somente quem abriu a consulta, com permissão de suporte, pode navegar por estes logs.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (customId === 'user-logs:queues') {
          await interaction.update(buildUserQueueCategoryPanel(selection.targetUsername));
          return;
        }
        if (customId === 'user-logs:home' || customId === 'user-logs:ticket-back') {
          selection.queueEntries = [];
          selection.ticketEntries = [];
          const queueEmoji = interaction.guild?.emojis.cache.find(emoji => emoji.name === 'salas~1');
          const ticketEmoji = interaction.guild?.emojis.cache.find(emoji => emoji.name === 'suporte');
          await interaction.update(buildUserLogsHome({
            id: selection.targetUserId,
            username: selection.targetUsername
          }, queueEmoji, ticketEmoji));
          return;
        }
        if (customId === 'user-logs:queue-back') {
          await interaction.update(buildUserQueueCategoryPanel(selection.targetUsername));
          return;
        }

        if (customId === 'user-logs:tickets') {
          const ticketEntries = findTicketLogsForUser(selection.targetUserId);
          selection.ticketEntries = ticketEntries;
          const panel = buildLogEntrySelectPanel({
            targetUsername: selection.targetUsername,
            title: `Tickets de ${selection.targetUsername}`,
            entries: ticketEntries.map(entry => ({
              ...entry,
              value: entry.ticketId
            })),
            customId: 'user-logs-ticket-select',
            backCustomId: 'user-logs:ticket-back',
            backLabel: 'Voltar'
          });
          await interaction.update(panel);
          return;
        }

        if (customId === 'user-logs:finished' || customId === 'user-logs:cancelled') {
          const outcome = customId.endsWith('finished') ? 'finished' : 'cancelled';
          await interaction.deferUpdate();
          const allEntries = await findQueueLogsForUser(interaction.guild, selection.targetUserId);
          const queueEntries = filterQueueLogsByOutcome(allEntries, outcome);
          selection.queueEntries = queueEntries;
          const panel = buildLogEntrySelectPanel({
            targetUsername: selection.targetUsername,
            title: outcome === 'finished'
              ? `Filas finalizadas de ${selection.targetUsername}`
              : `Filas canceladas de ${selection.targetUsername}`,
            entries: queueEntries.map(entry => ({
              value: entry.messageId,
              label: `${entry.title} • ${new Date(entry.timestamp).toLocaleString('pt-BR')}`,
              description: entry.text.split('\n').slice(1).join(' ').slice(0, 100)
            })),
            customId: 'user-logs-queue-select',
            backCustomId: 'user-logs:queue-back',
            backLabel: 'Voltar'
          });
          await interaction.editReply(panel);
          return;
        }
        return;
      }

      if (customId.startsWith('mediador-manage-page:')) {
        if (!canManageMediadorQueue(interaction.guild, interaction.member, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas donos e suportes podem gerenciar os mediadores.', flags: MessageFlags.Ephemeral });
          return;
        }

        const [, panelChannelId, panelMessageId, offsetRaw] = customId.split(':');
        const offset = Number(offsetRaw);
        if (!panelChannelId || !panelMessageId || !Number.isInteger(offset) || offset < 0) {
          await interaction.reply({ content: 'Não foi possível abrir essa página. Tente novamente.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.update(await buildMediadorManageMessage(
          interaction.guild,
          panelChannelId,
          panelMessageId,
          offset
        ));
        return;
      }

      if (customId.startsWith('queue-logs:')) {
        const selectionData = queueLogSelections.get(interaction.message.id);
        if (!selectionData) {
          await interaction.reply({ content: 'Esta consulta de logs expirou. Use `.logs` novamente.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!hasQueueLogAccess(interaction.member, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas o suporte e o owner configurado podem navegar pelos logs.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (customId === 'queue-logs:print') {
          const entry = selectionData.entries[selectionData.index];
          const logUrl = `https://discord.com/channels/${entry.guildId || interaction.guild.id}/${entry.channelId || queueLogsChannelId}/${entry.messageId}`;
          const text = [
            `Logs de ${selectionData.targetUsername} (${selectionData.targetUserId})`,
            entry.title,
            `Data: ${new Date(entry.timestamp).toLocaleString('pt-BR')}`,
            '',
            entry.text,
            '',
            entry.isArchived
              ? 'Transcrição arquivada: use o botão Ver na Web.'
              : `Ver na Web: ${logUrl}`
          ].join('\n');
          const attachment = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
            name: `fila-${entry.messageId}.txt`
          });
          await interaction.reply({
            content: '📄 Log pronto para imprimir.',
            files: [attachment],
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (customId === 'queue-logs:web') {
          const entry = selectionData.entries[selectionData.index];
          const queueLog = findArchivedQueueLog(entry, selectionData.targetUserId);
          if (!queueLog) {
            await interaction.reply({
              content: 'Não encontrei uma transcrição arquivada para esta fila. Somente filas arquivadas pelo bot podem ser exibidas.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          const transcriptHtml = buildQueueTranscriptHtml(queueLog);
          const attachment = new AttachmentBuilder(Buffer.from(transcriptHtml, 'utf8'), {
            name: `fila-${queueLog.queueId}.html`,
            description: 'Transcrição completa das mensagens arquivadas da fila'
          });
          await interaction.reply({
            content: '🌐 Transcrição pronta. Abra o arquivo HTML para ver as mensagens e os horários.',
            files: [attachment],
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (customId === 'queue-logs:back') {
          const targetUser = {
            id: selectionData.targetUserId,
            username: selectionData.targetUsername
          };
          const menu = buildQueueLogsMenu(targetUser, selectionData.entries);
          await interaction.update({ embeds: [menu.embed], components: menu.components });
          return;
        }

        if (customId === 'queue-logs:previous') {
          selectionData.index = Math.min(selectionData.index + 1, selectionData.entries.length - 1);
        } else if (customId === 'queue-logs:next') {
          selectionData.index = Math.max(selectionData.index - 1, 0);
        } else {
          return;
        }

        const entry = selectionData.entries[selectionData.index];
        const detail = buildQueueLogDetail(
          selectionData.targetUserId,
          entry,
          selectionData.index,
          selectionData.entries.length
        );
        await interaction.update({ embeds: [detail.embed], components: detail.components });
        return;
      }

      if (customId === 'result-delete-thread') {
        const threadChannel = interaction.channel;
        if (!threadChannel || typeof threadChannel.isThread !== 'function' || !threadChannel.isThread()) {
          await interaction.reply({ content: 'Este botão só pode ser usado no tópico da aposta.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!hasMediadorAccess(interaction.user.id)) {
          await interaction.reply({ content: 'Apenas mediadores autorizados podem excluir o tópico da aposta.', flags: MessageFlags.Ephemeral });
          return;
        }

        const threadMeta = apostaThreadMeta.get(threadChannel.id);
        if (!threadMeta?.resultRecorded) {
          await interaction.reply({ content: 'O resultado desta aposta ainda não foi registrado.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferUpdate();
        try {
          await saveQueueThreadLog(threadChannel, interaction.user.id, 'resultado-excluido', 'Tópico excluído após registro do resultado.');
          await threadChannel.delete('Tópico excluído após registro do resultado.');
          assignedBetAdministrators.delete(threadChannel.id);
          apostaConfirmations.delete(threadChannel.id);
          apostaThreadMeta.delete(threadChannel.id);
        } catch (error) {
          console.error(`Erro ao excluir tópico da aposta ${threadChannel.id} após registrar o resultado:`, error);
          await interaction.followUp({
            content: 'Não foi possível excluir o tópico. Verifique as permissões do bot e tente novamente.',
            flags: MessageFlags.Ephemeral
          });
        }
        return;
      }

      if (customId === 'rank-panel-profile') {
        const profile = getUserRecord(interaction.user.id);
        const thumbnail = getQueueThumbnail(interaction.guildId);
        const performance = getWinRatePercentage(profile).toLocaleString('pt-BR', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1
        });
        const profileEmbed = new EmbedBuilder()
          .setTitle(`Perfil de ${interaction.user.username}`)
          .setDescription(`Estatísticas de ${interaction.user}.`)
          .addFields(
            { name: 'Vitórias', value: `${profile.victories}`, inline: true },
            { name: 'Derrotas', value: `${profile.defeats}`, inline: true },
            { name: 'Desempenho', value: `${performance}%`, inline: true },
            { name: 'Vitórias consecutivas', value: `${profile.streak}`, inline: true },
            { name: 'Coins', value: `${profile.coins}`, inline: true }
          )
          .setColor(0x3498db)
          .setTimestamp();
        profileEmbed.setThumbnail(thumbnail.url);
        await interaction.reply({
          embeds: [profileEmbed],
          files: thumbnail.files,
          flags: MessageFlags.Ephemeral
        }).catch(() => null);
        return;
      }

      if (customId === 'rank-panel-rank') {
        const entries = getRankingEntries();
        const totalPages = Math.max(1, Math.ceil(entries.length / 10));
        const thumbnail = getQueueThumbnail(interaction.guildId);
        const embed = buildRankEmbed(entries, 1, 10, thumbnail.url);
        const navigation = buildRankNavigationRow(1, totalPages);
        await interaction.reply({
          embeds: [embed],
          components: [navigation],
          files: thumbnail.files,
          flags: MessageFlags.Ephemeral
        }).catch(() => null);
        return;
      }

      if (customId.startsWith('rank-')) {
        const [, direction, pageString] = customId.split(':');
        let page = Number.parseInt(pageString, 10) || 1;
        const entries = getRankingEntries();
        const totalPages = Math.max(1, Math.ceil(entries.length / 10));

        if (direction === 'prev') {
          page = Math.max(1, page - 1);
        } else if (direction === 'next') {
          page = Math.min(totalPages, page + 1);
        }

        const thumbnail = getQueueThumbnail(interaction.guildId);
        const embed = buildRankEmbed(entries, page, 10, thumbnail.url);
        const navigation = buildRankNavigationRow(page, totalPages);
        await interaction.update({ embeds: [embed], components: [navigation] }).catch(() => null);
        return;
      }

      if (customId === 'blacklist-check') {
        const modal = new ModalBuilder()
          .setCustomId('blacklist-check-modal')
          .setTitle('Verificar Blacklist')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('blacklistId')
                .setLabel('ID do usuário')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('123456789012345678')
                .setRequired(true)
            )
          );
        await interaction.showModal(modal);
        return;
      }

      if (customId === 'blacklist-add') {
        const isAllowed = hasSsAnalystAccess(interaction.member);
        if (!isAllowed) {
          await interaction.reply({ content: 'Você não tem autorização para isso.', flags: MessageFlags.Ephemeral }).catch(() => null);
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('blacklist-add-modal')
          .setTitle('Adicionar à Blacklist')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('blacklistId')
                .setLabel('ID do usuário')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('123456789012345678')
                .setRequired(true)
            )
          );
        await interaction.showModal(modal);
        return;
      }

      if (customId.startsWith('tmob-accept')) {
        if (!hasTeladorRole(interaction.member)) {
          await interaction.reply({ content: 'Você não tem autorização para aceitar esta telagem.', flags: MessageFlags.Ephemeral });
          return;
        }

        const [, targetChannelId] = customId.split(':');
        const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel) {
          await interaction.reply({ content: 'Canal de aposta não encontrado.', flags: MessageFlags.Ephemeral });
          return;
        }

        await targetChannel.members.add(interaction.user.id).catch(() => null);

        const acceptedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setDescription(`Telagem aceita por <@${interaction.user.id}> para o canal <#${targetChannel.id}>.`);

        const actionRow = new ActionRowBuilder().addComponents(
          applyGuildEmojiToButton(
            new ButtonBuilder()
              .setCustomId(`tmob-clean:${targetChannel.id}`)
              .setLabel('Limpo')
              .setStyle(ButtonStyle.Success),
            interaction.guild,
            'CheckV'
          ),
          applyGuildEmojiToButton(
            new ButtonBuilder()
              .setCustomId(`tmob-wo:${targetChannel.id}`)
              .setLabel('W.O')
              .setStyle(ButtonStyle.Danger),
            interaction.guild,
            'errado'
          ),
          applyGuildEmojiToButton(
            new ButtonBuilder()
              .setCustomId(`tmob-ss:${targetChannel.id}`)
              .setLabel('Chamar SS')
              .setStyle(ButtonStyle.Secondary),
            interaction.guild,
            'royalapostas'
          )
        );

        acceptedTeladorByChannel.set(targetChannel.id, interaction.user.id);
        teladorProfile.incrementTeladorTelagens(interaction.user.id);
        teladorProfile.startTeladorSessionForUser(interaction.user.id);
        await interaction.update({ embeds: [acceptedEmbed], components: [] }).catch(() => null);
        await targetChannel.send({ embeds: [new EmbedBuilder()
            .setTitle('Painel de Ações do Telador')
            .setDescription('Use os botões abaixo para marcar o resultado da telagem.')
            .setColor(0x3498db)
            .setTimestamp()], components: [actionRow] });
        await interaction.reply({ content: 'Telagem aceita com sucesso.', flags: MessageFlags.Ephemeral }).catch(() => null);
        return;
      }

      if (customId.startsWith('ssmob-accept')) {
        if (!hasSsAnalystAccess(interaction.member)) {
          await interaction.reply({ content: 'Você não tem autorização para aceitar esta análise de SS.', flags: MessageFlags.Ephemeral });
          return;
        }

        const [, targetChannelId] = customId.split(':');
        const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel) {
          await interaction.reply({ content: 'Canal de aposta não encontrado.', flags: MessageFlags.Ephemeral });
          return;
        }

        await targetChannel.members.add(interaction.user.id).catch(() => null);

        const acceptedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setTitle('Análise de SS Aceita')
          .setDescription(`Análise de SS aceita por <@${interaction.user.id}> para o canal <#${targetChannel.id}>.`);

        const actionRow = new ActionRowBuilder().addComponents(
          applyGuildEmojiToButton(
            new ButtonBuilder()
              .setCustomId(`ssmob-clean:${targetChannel.id}`)
              .setLabel('Limpo')
              .setStyle(ButtonStyle.Success),
            interaction.guild,
            'CheckV'
          ),
          applyGuildEmojiToButton(
            new ButtonBuilder()
              .setCustomId(`ssmob-wo:${targetChannel.id}`)
              .setLabel('W.O')
              .setStyle(ButtonStyle.Danger),
            interaction.guild,
            'errado'
          )
        );

        acceptedAnalystByChannel.set(targetChannel.id, interaction.user.id);
        await interaction.update({ embeds: [acceptedEmbed], components: [] }).catch(() => null);
        analistaProfile.incrementAnalistaAnalises(interaction.user.id);
        analistaProfile.startAnalistaSessionForUser(interaction.user.id);
        await targetChannel.send({ embeds: [new EmbedBuilder()
            .setTitle('Painel de Ações do Analista')
            .setDescription('Use os botões abaixo para marcar o resultado da análise.')
            .setColor(0x3498db)
            .setTimestamp()], components: [actionRow] });
        await sendLogEmbed(
          interaction.guild,
          analystLogsChannelId,
          'Analista aceitou análise',
          `Analista: <@${interaction.user.id}>\nCanal da aposta: <#${targetChannel.id}>`,
          0x3498db,
          'analistas',
          targetChannel.id
        );
        await interaction.reply({ content: 'Análise aceita e você foi adicionado à aposta.', flags: MessageFlags.Ephemeral }).catch(() => null);
        return;
      }

      if ((customId.startsWith('tmob-') || customId.startsWith('ssmob-')) && customId !== 'tmob-accept') {
        const [prefix, targetChannelId] = customId.split(':');
        const isSsAction = prefix.startsWith('ssmob-');
        const action = prefix.slice(prefix.indexOf('-') + 1);
        const validActions = isSsAction ? ['clean', 'wo'] : ['clean', 'wo', 'ss'];
        if (!validActions.includes(action)) {
          await interaction.reply({ content: 'Esta ação não é válida.', flags: MessageFlags.Ephemeral });
          return;
        }

        const allowedActorId = isSsAction ? acceptedAnalystByChannel.get(targetChannelId) : acceptedTeladorByChannel.get(targetChannelId);

        if (allowedActorId !== interaction.user.id) {
          await interaction.reply({ content: 'Apenas quem aceitou esta telagem pode interagir com os botões.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!hasTeladorRole(interaction.member) && !hasSsAnalystAccess(interaction.member)) {
          await interaction.reply({ content: 'Você não tem autorização para marcar o resultado desta telagem.', flags: MessageFlags.Ephemeral });
          return;
        }

        const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel) {
          await interaction.reply({ content: 'Canal de aposta não encontrado.', flags: MessageFlags.Ephemeral });
          return;
        }

        const panelEmbed = EmbedBuilder.from(interaction.message.embeds[0] || new EmbedBuilder());
        let description;

        if (action === 'clean') {
          description = isSsAction
            ? `O analista de SS <@${interaction.user.id}> definiu a análise como limpo.`
            : `O telador <@${interaction.user.id}> definiu a telagem como limpo.`;
        } else if (action === 'wo') {
          description = isSsAction
            ? `O analista de SS <@${interaction.user.id}> definiu a análise como W.O.`
            : `O telador <@${interaction.user.id}> definiu a telagem como W.O.`;
        } else if (action === 'ss') {
          description = `O telador <@${interaction.user.id}> decidiu Chamar SS.`;

          if (!ssmobChannelId) {
            await interaction.reply({ content: 'O canal de SS não está configurado.', flags: MessageFlags.Ephemeral });
            return;
          }

          const ssmobChannel = await client.channels.fetch(ssmobChannelId).catch(() => null);
          if (!ssmobChannel || !ssmobChannel.isTextBased()) {
            await interaction.reply({ content: 'O canal de SS configurado é inválido.', flags: MessageFlags.Ephemeral });
            return;
          }

          const ssmobEmbed = new EmbedBuilder()
            .setTitle('Solicitação de SS')
            .setDescription(`Uma nova solicitação de SS foi gerada a partir da telagem no canal <#${targetChannel.id}>. Clique em Aceitar Análise para assumir.`)
            .addFields(
              { name: 'Canal de aposta', value: `${targetChannel}`, inline: false },
              { name: 'Solicitado por', value: `<@${interaction.user.id}>`, inline: false }
            )
            .setColor(0x3498db)
            .setTimestamp();

          const ssmobRow = new ActionRowBuilder().addComponents(
            applyGuildEmojiToButton(
              new ButtonBuilder()
                .setCustomId(`ssmob-accept:${targetChannel.id}`)
                .setLabel('Aceitar Análise')
                .setStyle(ButtonStyle.Success),
              interaction.guild,
              'CheckV'
            )
          );

          await ssmobChannel.send({ embeds: [ssmobEmbed], components: [ssmobRow] }).catch(() => null);
        }

        if (isSsAction) {
          await sendLogEmbed(
            interaction.guild,
            analystLogsChannelId,
            'Resultado da análise registrado',
            `${description}\nCanal da aposta: <#${targetChannel.id}>`,
            action === 'wo' ? 0xff6b6b : 0x2ecc71,
            'analistas',
            targetChannel.id
          );
        }

        if (!isSsAction && hasTeladorRole(interaction.member)) {
          teladorProfile.stopTeladorSessionForUser(interaction.user.id);
        }

        panelEmbed.setDescription(description);
        await interaction.update({ embeds: [panelEmbed], components: [] }).catch(() => null);
        await interaction.reply({ content: 'Ação registrada com sucesso.', flags: MessageFlags.Ephemeral }).catch(() => null);
        return;
      }

      if (customId === 'aux-finalizar-aposta') {
        const canFinalize = isOwnerAccess(interaction.guild, interaction.user.id) || hasQueueManagerRole(interaction.member);
        if (!canFinalize) {
          await interaction.reply({ content: 'Apenas o  ADM pode finalizar esta aposta.', flags: MessageFlags.Ephemeral });
          return;
        }

        const targetChannel = interaction.channel || interaction.message?.channel;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);

        try {
          if (targetChannel) {
            await saveQueueThreadLog(targetChannel, interaction.user.id, 'finalizado', 'Finalizado via botão de término de aposta').catch(() => null);
          }
          await deleteChannelSafely(targetChannel);
          await interaction.editReply({ content: '✅ Aposta finalizada.' }).catch(() => null);
        } catch (error) {
          console.error('Erro ao finalizar aposta do .aux:', error);
          await interaction.editReply({ content: 'Não foi possível finalizar esta aposta no momento.' }).catch(() => null);
        }
        return;
      }

      if (customId === 'mediador-enter' || customId === 'mediador-leave') {
        const member = interaction.member;
        if (customId === 'mediador-enter'
          && !canJoinMediatorQueue(member, interaction.user.id, mediadorQueueRoleId, ownerId)) {
          await interaction.reply({
            content: 'Apenas membros com o cargo autorizado podem entrar na fila de mediadores.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (customId === 'mediador-leave' && (!member || (!hasAllowedQueueRole(member) && !hasQueueManagerRole(member)))) {
          await interaction.reply({ content: 'Apenas mediadores ou cargos autorizados podem usar este botão.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (customId === 'mediador-enter') {
          if (!mediadorPixData.has(interaction.user.id)) {
            await interaction.reply({
              content: 'Você precisa registrar o PIX antes de entrar na fila de controle. Use o comando .pix.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          if (mediadorControlQueue.includes(interaction.user.id)) {
            await interaction.update({ components: [buildMediadorActionRow()] }).catch(() => null);
            return;
          }

          mediadorControlQueue.push(interaction.user.id);
          const startedAt = startMediadorQueueSessionForUser(interaction.user.id);
          saveMediadorControlQueueState();
          await sendLogEmbed(
            interaction.guild,
            mediatorLogsChannelId,
            'Mediador entrou na fila de controle',
            `Mediador: <@${interaction.user.id}>\nEntrou: ${formatMediadorSessionTimestamp(startedAt)}\nFilas pegas nesta sessão: 0`,
            0x2ecc71,
            'mediadores'
          );

          const isConfiguredMediatorEntry = String(interaction.user.id) === String(mediadorId);
          if (isConfiguredMediatorEntry && interaction.guild && apostasChannelId) {
            const queueData = getGuildFFQueue(interaction.guild.id);
            const announcement = buildFilaStatusAnnouncement(queueData);
            const apostasChannel = await interaction.guild.channels.fetch(apostasChannelId).catch(() => null);
            if (apostasChannel && apostasChannel.isTextBased()) {
              try {
                const recentMessages = await apostasChannel.messages.fetch({ limit: 50 }).catch(() => new Map());
                const previousAnnouncements = recentMessages.filter(message =>
                  message.author?.id === interaction.client?.user?.id && message.content === announcement
                );

                if (previousAnnouncements.size > 0) {
                  await Promise.all(previousAnnouncements.map(message => message.delete().catch(() => null)));
                }
              } catch (cleanupError) {
                console.error('Erro ao limpar anúncio anterior de filas:', cleanupError);
              }

              await apostasChannel.send(announcement).catch(() => null);
            }
          }

          if (interaction.message && interaction.message.editable) {
            try {
              const newEmbed = buildMediadorPanelEmbed();
              const oldEmbed = interaction.message.embeds?.[0];
              if (oldEmbed && oldEmbed.image?.url) newEmbed.setImage(oldEmbed.image.url);
              await interaction.message.edit({ embeds: [newEmbed], components: [buildMediadorActionRow()] }).catch(() => null);
            } catch (e) {}
          }
          await interaction.deferUpdate().catch(() => null);
          return;
        }

        const userIndex = mediadorControlQueue.indexOf(interaction.user.id);
        if (userIndex === -1) {
          await interaction.update({ components: [buildMediadorActionRow()] }).catch(() => null);
          return;
        }

        mediadorControlQueue.splice(userIndex, 1);
        const mediatorSession = stopMediadorQueueSessionForUser(interaction.user.id);
        saveMediadorControlQueueState();
        await sendLogEmbed(
          interaction.guild,
          mediatorLogsChannelId,
          'Mediador saiu da fila de controle',
          `Mediador: <@${interaction.user.id}>\n${buildMediadorSessionLogDetails(mediatorSession)}`,
          0xff6b6b,
          'mediadores'
        );

        if (interaction.message && interaction.message.editable) {
          try {
            const newEmbed = buildMediadorPanelEmbed();
            const oldEmbed = interaction.message.embeds?.[0];
            if (oldEmbed && oldEmbed.image?.url) newEmbed.setImage(oldEmbed.image.url);
            await interaction.message.edit({ embeds: [newEmbed], components: [buildMediadorActionRow()] }).catch(() => null);
          } catch (e) {}
        }
        await interaction.deferUpdate().catch(() => null);
        return;
      }

      if (customId === 'mediador-pix-config') {
        const member = interaction.member;
        const canUsePixConfig = canConfigurePix(member, interaction.user.id, {
          ownerId,
          mediadorIds,
          queueManagerRoleIds,
          supportRoleIds,
          auxiliarRoleIds
        });
        if (!member || !canUsePixConfig) {
          await interaction.reply({ content: 'Apenas o mediador pode cadastrar o PIX.', flags: MessageFlags.Ephemeral });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('mediador-pix-config-modal')
          .setTitle('Dados do PIX do mediador')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('pixBankName')
                .setLabel('Nome do titular')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('Ex: Guilherme da Silva Souza')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('pixKey')
                .setLabel('Chave Pix')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('email, CPF, chave aleatória...')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('pixMessage')
                .setLabel('Mensagem')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setPlaceholder('Mensagem que vai acompanhar o PIX')
            )
          );

        await interaction.showModal(modal);
        return;
      }

      if (customId === 'mediador-pix-check') {
        const canCheckPix = canConfigurePix(interaction.member, interaction.user.id, {
          ownerId,
          mediadorIds,
          queueManagerRoleIds,
          supportRoleIds,
          auxiliarRoleIds
        });
        if (!canCheckPix) {
          await interaction.reply({
            content: 'Apenas mediadores ou cargos autorizados podem verificar o cadastro.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const pixData = mediadorPixData.get(interaction.user.id);
        if (!pixData) {
          await interaction.reply({
            content: 'Você ainda não cadastrou seus dados do Pix.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const pixEmbed = new EmbedBuilder()
          .setTitle('Confira Seus Dados Abaixo:')
          .setColor(0xffeb3b)
          .addFields(
            { name: 'Nome:', value: `> ${(pixData.bankName || 'Não informado').slice(0, 1022)}`, inline: false },
            { name: 'Chave Pix:', value: `> ${(pixData.pixKey || 'Não informada').slice(0, 1022)}`, inline: false }
          );
        await interaction.reply({
          embeds: [pixEmbed],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (customId === 'mediador-pix-admin-check') {
        const canViewAllPix = isOwnerAccess(interaction.guild, interaction.user.id)
          || hasQueueManagerRole(interaction.member);
        if (!canViewAllPix) {
          await interaction.reply({
            content: 'Apenas a administração autorizada pode verificar todos os cadastros Pix.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (mediadorPixData.size === 0) {
          await interaction.reply({
            content: 'Nenhum cadastro Pix foi encontrado.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const mediatorSelect = new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId('mediador-pix-admin-select')
            .setPlaceholder('Selecione o mediador.')
            .setMinValues(1)
            .setMaxValues(1)
        );
        await interaction.reply({
          content: 'Selecione o mediador para consultar o cadastro Pix.',
          components: [mediatorSelect],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId === 'mediador-manage') {
        if (!canManageMediadorQueue(interaction.guild, interaction.member, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas donos e suportes podem gerenciar os mediadores.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.reply({
          ...await buildMediadorManageMessage(interaction.guild, interaction.channelId, interaction.message.id),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId.startsWith('aux-') && customId !== 'aux-finalizar-aposta') {
        await interaction.reply({ content: 'Esta ação só pode ser usada dentro de um painel de aposta válido.', flags: MessageFlags.Ephemeral }).catch(() => null);
        return;
      }

      if (customId === 'ff-queue-publish-auto') {
        if (!isOwnerAccess(interaction.guild, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas o SOUZA pode publicar filas.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let guildChannels;
        try {
          guildChannels = await interaction.guild.channels.fetch();
        } catch (error) {
          console.error('Erro ao localizar canais de filas:', error);
          await respondToInteraction(interaction, {
            content: 'Não foi possível procurar os canais do servidor. Verifique as permissões do bot e tente novamente.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const destinations = findQueueChannelConfigurations(
          [...guildChannels.values()].filter(channel => channel.type === ChannelType.GuildText)
        );
        if (destinations.length === 0) {
          await respondToInteraction(interaction, {
            content: 'Não encontrei canais com fila e modo no nome. Nomeie os canais, por exemplo, `mobile-1v1`, `emulador-2v2` ou `misto-4v4`.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const publishedChannels = [];
        const failedChannels = [];
        const playersEmoji = getQueuePlayersEmoji(interaction.guild);
        const valueEmoji = getQueueValueEmoji(interaction.guild);

        for (const { channel, queueType, mode } of destinations) {
          const modeEmoji = getQueueModeEmoji(interaction.guild, queueType);
          const queueData = getGuildFFQueue(interaction.guild.id);
          const settings = queueData.queues?.[queueType]?.settings || getQueueSettings(queueData);
          const queueThumbnail = buildQueueThumbnail();
          const betValues = sortBetValuesDescending(settings.betValues);
          const queueTitle = `${ffQueueTypes[queueType].emoji} Fila ${ffQueueTypes[queueType].label}`;
          let channelPublished = false;

          if (betValues.length === 0) {
            console.warn(`Fila ${queueType} sem valores configurados; publicação ignorada no canal ${channel.id}.`);
            failedChannels.push(`<#${channel.id}> (sem valores configurados)`);
            continue;
          }

          try {
            for (const betValue of betValues) {
              const formattedValue = typeof betValue === 'number'
                ? `R$ ${betValue.toFixed(2).replace('.', ',')}`
                : String(betValue);
              const embed = new EmbedBuilder()
                .setTitle(`${queueTitle} | ${mode.toUpperCase()}`)
                .setDescription(`Modo: **${mode.toUpperCase()}**\nTipo: **${queueType}**`)
                .addFields(
                  { name: `${modeEmoji ? `${modeEmoji} ` : ''}Modo`, value: mode.toUpperCase(), inline: true },
                  { name: `${valueEmoji} Valor`, value: formattedValue, inline: true },
                  { name: `${playersEmoji} Jogadores`, value: 'Nenhum jogador na fila', inline: false }
                )
                .setColor(0x3498db)
                .setTimestamp();

              applyQueueImageToEmbed(embed, queueThumbnail);

              await channel.send({
                embeds: [embed],
                components: [buildQueueEntryActionRow(queueType, mode, interaction.guild)],
                files: queueThumbnail.files
              });
              channelPublished = true;
            }
            publishedChannels.push(`<#${channel.id}> (${queueType} ${mode.toUpperCase()})`);
          } catch (error) {
            console.error(`Erro ao publicar fila ${queueType} ${mode} no canal ${channel.id}:`, error);
            failedChannels.push(`<#${channel.id}>${channelPublished ? ' (publicação parcial)' : ''}`);
          }
        }

        if (queueLogsChannelId && publishedChannels.length > 0) {
          try {
            await sendLogEmbed(
              interaction.guild,
              queueLogsChannelId,
              'Filas publicadas',
              `Publicadas por <@${interaction.user.id}>:\n${publishedChannels.join('\n')}${failedChannels.length ? `\nFalhas:\n${failedChannels.join('\n')}` : ''}`,
              0xffffff,
              'filas'
            );
          } catch (error) {
            console.error('Erro ao registrar publicação das filas:', error);
          }
        }

        const resultLines = [];
        if (publishedChannels.length > 0) {
          resultLines.push(`✅ Filas enviadas:\n${publishedChannels.join('\n')}`);
        }
        if (failedChannels.length > 0) {
          resultLines.push(`⚠️ Não foi possível publicar em:\n${failedChannels.join('\n')}`);
        }
        if (publishedChannels.length === 0 && failedChannels.length === 0) {
          resultLines.push('Nenhum canal válido foi encontrado para publicar.');
        }

        await respondToInteraction(interaction, {
          content: resultLines.join('\n\n'),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId === 'ff-queue-publish') {
        if (!isOwnerAccess(interaction.guild, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas o SOUZA pode publicar filas.', flags: MessageFlags.Ephemeral });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('ff-queue-publish-modal')
          .setTitle('Publicar filas de Free Fire')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('queueMode')
                .setLabel('Modo da fila (1v1, 2v2, 3v3, 4v4)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('1v1')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('queueType')
                .setLabel('Tipo da fila (Mobile, Emulador ou Misto)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('Mobile')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('betValues')
                .setLabel('Valores (opcional; ex.: 1, 0.50, 0.25)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(4000)
                .setPlaceholder('Em branco usa os valores configurados')
            )
          );

        await interaction.showModal(modal);
        return;
      }

      if (customId === 'aposta-confirm' || customId === 'aposta-cancel') {
        const threadChannel = interaction.channel || interaction.message?.channel;
        const threadId = interaction.channelId || threadChannel?.id;
        const embed = interaction.message.embeds[0];
        const threadMeta = apostaThreadMeta.get(threadId) || {};
        const participantIds = [...new Set((threadMeta.playerIds || parseQueuePlayersFromEmbed(embed).map(player => player.id)).map(String))];
        const threadMediadorId = assignedBetAdministrators.get(threadId) || null;

        if (customId === 'aposta-cancel') {
          const threadChannelName = String(threadChannel?.name || '').toLowerCase();
          const isAguardandoTopic = threadChannelName === 'aguardando';
          const canCancel = isAguardandoTopic || interaction.user.id === threadMediadorId || isOwnerAccess(interaction.guild, interaction.user.id) || hasQueueManagerRole(interaction.member);
          if (!canCancel) {
            await interaction.reply({ content: 'Apenas o mediador responsável, o dono ou um gerente pode cancelar esta fila.', flags: MessageFlags.Ephemeral });
            return;
          }
        }

        if (!participantIds.includes(String(interaction.user.id)) && customId !== 'aposta-cancel') {
          await interaction.reply({ content: 'Você não faz parte desta aposta.', flags: MessageFlags.Ephemeral });
          return;
        }

        const otherPlayerId = participantIds.find(id => id !== String(interaction.user.id)) || null;
        const otherPlayerText = otherPlayerId ? `<@${otherPlayerId}>` : 'outro jogador';

        if (customId === 'aposta-confirm') {
          const confirmations = apostaConfirmations.get(threadId) || new Set();

          if (confirmations.has(String(interaction.user.id))) {
            const waitingForPlayer = participantIds.find(id => id !== String(interaction.user.id)) || null;
            await interaction.reply({
              content: waitingForPlayer ? `Você já confirmou a aposta, aguarde o <@${waitingForPlayer}>` : 'Você já confirmou a aposta, aguarde o outro jogador.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          confirmations.add(interaction.user.id);
          apostaConfirmations.set(threadId, confirmations);

          const confirmedPlayerIds = participantIds;
          const allConfirmed = participantIds.length > 1 && participantIds.every(playerId => confirmations.has(playerId));
          await sendLogEmbed(
            interaction.guild,
            confirmedLogsChannelId,
            'Aposta confirmada',
            `Confirmado por: <@${interaction.user.id}>\nJogadores: ${participantIds.map(id => `<@${id}>`).join(' e ') || 'Não informado'}\nMediador: ${threadMediadorId ? `<@${threadMediadorId}>` : 'Não informado'}\nConfirmação: ${allConfirmed ? 'Todos confirmaram' : 'Aguardando o outro jogador'}`,
            0x2ecc71,
            'apostas-confirmadas',
            threadId
          );

          if (allConfirmed && threadChannel) {
            if (!threadMediadorId) {
              confirmations.delete(String(interaction.user.id));
              apostaConfirmations.set(threadId, confirmations);
              console.error(`Não foi possível finalizar a fila ${threadId}: nenhum mediador foi designado.`);
              await interaction.reply({
                content: 'Os dois jogadores confirmaram, mas não foi possível identificar o mediador responsável. A confirmação foi reaberta para tentar novamente.',
                flags: MessageFlags.Ephemeral
              });
              return;
            }

            try {
              await threadChannel.members.add(threadMediadorId);
            } catch (error) {
              confirmations.delete(String(interaction.user.id));
              apostaConfirmations.set(threadId, confirmations);
              console.error(`Erro ao adicionar o mediador ${threadMediadorId} à fila ${threadId} após as confirmações:`, error);
              await interaction.reply({
                content: 'Os dois jogadores confirmaram, mas não foi possível adicionar o mediador à fila. A confirmação foi reaberta para tentar novamente.',
                flags: MessageFlags.Ephemeral
              });
              return;
            }

            const threadMeta = apostaThreadMeta.get(threadId) || {};
            const finalThreadName = getQueueThreadName(
              threadMeta.selectedBetType || threadMeta.queueType || threadMeta.betType,
              threadMeta.queueNumber
            );
            const assignedMediadorText = threadMediadorId ? `Mediador responsável: <@${threadMediadorId}>` : 'Não configurado';
            const playerTexts = confirmedPlayerIds.map(id => `<@${id}>`).join(' e ');
            try {
              await threadChannel.setName(finalThreadName);
            } catch (error) {
              console.error(`Erro ao renomear a fila ${threadId} após as confirmações:`, error);
            }
            await interaction.message.edit({ components: [] }).catch(() => null);

            const releasePixPanel = new EmbedBuilder()
              .setTitle('Aposta confirmada')
              .setColor(0x3498db)
              .addFields(
                { name: 'Jogadores', value: playerTexts || 'Não informado', inline: false },
                { name: 'Mediador responsável', value: assignedMediadorText, inline: false },
                { name: 'Valor a pagar', value: formatCentsToCurrency(threadMeta.betCents || 0), inline: false },
                { name: 'Status', value: 'Aguardando liberação do PIX. Depois, o mediador confirma cada recebimento nos botões do QR Code.', inline: false }
              )
              .setTimestamp();

            const releaseRow = new ActionRowBuilder().addComponents(
              buildReleasePixButton(interaction.guild)
            );

            await threadChannel.send({
              content: `${playerTexts} ${assignedMediadorText}`,
              embeds: [releasePixPanel],
              components: [releaseRow]
            }).catch(() => null);

            apostaConfirmations.delete(threadId);
            await interaction.deferUpdate().catch(() => null);
            return;
          }

          const partialConfirmed = `<@${interaction.user.id}> confirmou. Agora falta ${otherPlayerText}.`;
          await threadChannel.send({ content: partialConfirmed }).catch(() => null);
          await interaction.deferUpdate().catch(() => null);
          return;
        }

        const cancelingMention = `<@${interaction.user.id}>`;

        try {
          if (rejectedLogsChannelId && interaction.guild) {
            await sendLogEmbed(
              interaction.guild,
                rejectedLogsChannelId,
              'Fila cancelada',
                `Cancelada por: ${cancelingMention}\nParticipantes: ${participantIds.map(id => `<@${id}>`).join(' e ')}\nMediador: ${threadMediadorId ? `<@${threadMediadorId}>` : 'Não informado'}`,
              0xff6b6b,
                'apostas-recusadas',
              threadChannel?.id
            );
          }
        } catch (logError) {
          console.error('Erro ao enviar log de fila cancelada:', logError);
        }

        try {
          await interaction.reply({ content: `${cancelingMention} cancelou a aposta, este canal será excluído em breve.` });
        } catch (replyError) {
          if (replyError?.code !== 10062) {
            throw replyError;
          }
        }

        setTimeout(async () => {
          try {
            if (threadChannel) {
              await saveQueueThreadLog(threadChannel, interaction.user.id, 'cancelado', `Cancelado por <@${interaction.user.id}>`).catch(() => null);
              assignedBetAdministrators.delete(threadChannel.id);
              apostaConfirmations.delete(threadChannel.id);
              apostaThreadMeta.delete(threadChannel.id);
              await threadChannel.delete().catch(() => null);
            }
          } catch (error) {
            console.error('Erro ao excluir tópico de aposta cancelado:', error);
          }
        }, 5000);
        return;
      }

      if (customId === 'aposta-liberar-pix') {
        const threadChannel = interaction.channel;
        const mediadorIdForThread = assignedBetAdministrators.get(threadChannel?.id) || null;
        if (!mediadorIdForThread) {
          await interaction.reply({ content: 'Não foi possível identificar o mediador responsável desta aposta.', flags: MessageFlags.Ephemeral });
          return;
        }

        const canRelease = interaction.user.id === mediadorIdForThread || isOwnerAccess(interaction.guild, interaction.user.id) || hasQueueManagerRole(interaction.member);
        if (!canRelease) {
          await interaction.reply({ content: 'Apenas o mediador responsável da fila pode liberar o PIX.', flags: MessageFlags.Ephemeral });
          return;
        }

        const threadMeta = apostaThreadMeta.get(threadChannel?.id) || {};
        if (threadMeta.pixReleased) {
          await interaction.reply({ content: 'Este PIX já foi liberado para esta fila.', flags: MessageFlags.Ephemeral });
          return;
        }

        const pixData = mediadorPixData.get(mediadorIdForThread);
        if (!pixData) {
          await interaction.reply({ content: 'O mediador ainda não cadastrou os dados do PIX.', flags: MessageFlags.Ephemeral });
          return;
        }

        const betAmountCents = Number(threadMeta.betCents) || 0;
        const feeCents = Number(threadMeta.feeCents) || 0;
        const paymentAmountCents = betAmountCents + feeCents;
        threadMeta.pixReleased = true;
        apostaThreadMeta.set(threadChannel.id, threadMeta);
        try {
          const pixPayload = buildPixPayload({
            pixKey: pixData.pixKey,
            receiverName: pixData.bankName,
            amountCents: paymentAmountCents
          });
          const pixQrCode = await QRCode.toBuffer(pixPayload, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 512
          });
          const pixQrAttachment = new AttachmentBuilder(pixQrCode, { name: 'pix-pagamento.png' });
          const pixEmbed = new EmbedBuilder()
            .setTitle('QR Code Pix')
            .setColor(0x3498db)
            .setImage('attachment://pix-pagamento.png')
            .addFields(
              { name: 'Pix copia e cola', value: `\`${pixPayload}\``, inline: false },
            )
            .setTimestamp();

          const pixDetails = [
            `**Valor a pagar:** ${formatCentsToCurrency(paymentAmountCents)}`,
            `**Taxa incluída:** ${formatCentsToCurrency(feeCents)}`,
            `**Nome:** ${pixData.bankName || 'Não informado'}`,
            `**Chave:** \`${pixData.pixKey || 'Não informada'}\``
          ];
          if (pixData.message) pixDetails.push(`**Mensagem:** ${pixData.message}`);

          const pixReleaseRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('pix-copy-key')
              .setLabel('Copiar Chave Pix')
              .setStyle(ButtonStyle.Secondary)
          );

          await threadChannel.send({
            content: pixDetails.join('\n'),
            embeds: [pixEmbed],
            files: [pixQrAttachment],
            components: [pixReleaseRow]
          });
          apostaThreadMeta.set(threadChannel.id, threadMeta);
        } catch (error) {
          delete threadMeta.pixReleased;
          apostaThreadMeta.set(threadChannel.id, threadMeta);
          console.error(`Erro ao enviar QR Pix no canal ${threadChannel.id}:`, error);
          await interaction.reply({ content: 'Não foi possível gerar ou enviar o QR Pix. Verifique os dados cadastrados e tente novamente.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.message.edit({
          components: [
            new ActionRowBuilder().addComponents(
              buildReleasePixButton(interaction.guild, true)
            )
          ]
        }).catch(() => null);

        await interaction.reply({ content: 'PIX liberado com sucesso.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (customId === 'pix-copy-key') {
        const mediatorUserId = assignedBetAdministrators.get(interaction.channelId);
        const pixKey = mediatorUserId ? mediadorPixData.get(mediatorUserId)?.pixKey : '';
        if (!pixKey) {
          await interaction.reply({ content: 'Não foi possível localizar a chave Pix desta aposta.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: pixKey,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId.startsWith('room-copy-id:')) {
        const roomId = customId.slice('room-copy-id:'.length);
        if (!roomId) {
          await interaction.reply({ content: 'Não foi possível localizar o ID desta sala.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: `ID da sala: \`${roomId}\``, flags: MessageFlags.Ephemeral });
        return;
      }

      if (customId === 'room-edit-room') {
        await interaction.reply({
          content: '<:alerta:> Para alterar o valor da sala, envie o novo valor no canal da aposta ou solicite o ajuste pelo mediador responsável.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId.startsWith('ff-queue:')) {
        if (!isOwnerAccess(interaction.guild, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas o SOUZA pode alterar as filas.', flags: MessageFlags.Ephemeral });
          return;
        }

        const [, queueType] = customId.split(':');

        if (queueType === 'publish') {
          const queueData = getGuildFFQueue(interaction.guild.id);
          await interaction.channel.send({ embeds: [buildFFQueueOverviewEmbed(queueData, interaction.guild)] });
          if (!queueLogsChannelId) {
            console.warn('Aviso: canal de logs de filas não está configurado.');
          } else {
            await sendLogEmbed(interaction.guild, queueLogsChannelId, 'Filas publicadas', `Filas publicadas por <@${interaction.user.id}>. Tipo: ${queueType}.`, 0xffffff, 'filas');
          }
          await interaction.reply({ content: '✅ Filas publicadas no canal.', flags: MessageFlags.Ephemeral });
          return;
        }

        const queueData = getGuildFFQueue(interaction.guild.id);
        const modal = new ModalBuilder()
          .setCustomId(`ff-queue-config:${queueType}`)
          .setTitle(`Editar fila ${ffQueueTypes[queueType]?.label || queueType}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('entryAmount')
                .setLabel('Aposta padrão (coins)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(String(queueData.queues[queueType].settings.defaultEntryAmount))
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('minPlayers')
                .setLabel('Mínimo para iniciar')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(String(queueData.queues[queueType].settings.minPlayersToStart))
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('maxPlayers')
                .setLabel('Máximo da fila')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(String(queueData.queues[queueType].settings.maxPlayersPerQueue))
            )
          );

        await interaction.showModal(modal);
        return;
      }

      if (customId === 'config-edit') {
        if (!isOwnerAccess(interaction.guild, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas o SOUZA pode alterar a configuração.', flags: MessageFlags.Ephemeral });
          return;
        }

        const queueData = getGuildFFQueue(interaction.guild.id);
        const settings = queueData.queues?.Mobile?.settings || getQueueSettings(queueData);
        const bannerInput = new TextInputBuilder()
          .setCustomId('banner')
          .setLabel('Thumbnail dos painéis auxiliares')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder('https://... (vazio remove a thumbnail dos painéis)');
        if (settings.banner) bannerInput.setValue(settings.banner);

        const modal = new ModalBuilder()
          .setCustomId('ff-config-edit-modal')
          .setTitle('Editar configuração da fila')
          .addComponents(
            new ActionRowBuilder().addComponents(bannerInput),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('betValues')
                .setLabel('Valores das apostas (ex.: 0.10, 0.20)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(4000)
                .setValue(sortBetValuesDescending(settings.betValues).join(', '))
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('feeCents')
                .setLabel('Taxa em centavos')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(4000)
                .setValue(String(settings.feeCents || 0))
            )
          );

        await interaction.showModal(modal);
        return;
      }

      if (customId.startsWith('bet:')) {
        const [, betType, queueType, mode] = customId.split(':');
        const effectiveMode = String(mode || '').trim() || '1v1';
        if (!betType || !queueType || !mode) {
          await interaction.reply({ content: 'Botão de aposta inválido.', flags: MessageFlags.Ephemeral });
          return;
        }

        const embed = interaction.message.embeds[0];
        if (!embed) {
          await interaction.reply({ content: 'Não encontrei o embed da aposta.', flags: MessageFlags.Ephemeral });
          return;
        }

        const blacklist = readBlacklist();
        if (blacklist.includes(String(interaction.user.id))) {
          await interaction.reply({
            content: 'erro: Você está na blacklist e não pode entrar na fila de apostas.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const players = parseQueuePlayersFromEmbed(embed);
        const betLabel = getBetLabel(betType);
        const existing = players.find(player => player.id === interaction.user.id);

        if (betType !== 'leave' && mediadorControlQueue.length === 0) {
          await interaction.reply({ content: 'Não temos mediadores disponíveis no momento.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (betType === 'leave') {
          if (!existing) {
            await interaction.reply({ content: 'Você não está nessa fila.', flags: MessageFlags.Ephemeral });
            return;
          }

          const remaining = players.filter(player => player.id !== interaction.user.id);
          await interaction.deferUpdate();
          try {
            const newEmbed = updateQueueEmbedPlayers(embed, remaining);
            const oldEmbed = interaction.message?.embeds?.[0];
            if (oldEmbed && oldEmbed.image?.url && !(newEmbed?.data?.image?.url)) newEmbed.setImage(oldEmbed.image.url);
            await interaction.message.edit(buildQueueMessageEditOptions(
              interaction.message,
              newEmbed,
              [buildQueueEntryActionRow(queueType, effectiveMode, interaction.guild)]
            ));
          } catch (error) {
            console.error('Erro ao atualizar a fila após saída de jogador:', error);
            await interaction.followUp({ content: 'Não foi possível atualizar a fila. Tente novamente.', flags: MessageFlags.Ephemeral }).catch(() => null);
          }
          return;
        }

        if (betType !== 'leave' && !interaction.member) {
          await interaction.reply({ content: 'Não foi possível identificar seu membro no servidor.', flags: MessageFlags.Ephemeral });
          return;
        }

        const formattedValue = embed.fields?.find(f => String(f.name || '').includes('Valor'))?.value || betLabel;
        const createBetFromQueuePlayers = async threadPlayerIds => {
          await interaction.deferUpdate();

          const departedPlayerIds = [];
          for (const playerId of threadPlayerIds) {
            try {
              await interaction.guild.members.fetch(playerId);
            } catch (error) {
              if (isUnknownGuildMemberError(error)) {
                departedPlayerIds.push(String(playerId));
                continue;
              }

              console.error(`Erro ao verificar jogador ${playerId} antes de criar a aposta:`, error);
              await interaction.followUp({
                content: 'Não foi possível verificar os jogadores da fila. Tente novamente.',
                flags: MessageFlags.Ephemeral
              }).catch(() => null);
              return;
            }
          }

          if (departedPlayerIds.length > 0) {
            const remaining = removeQueuePlayers(players, departedPlayerIds);
            try {
              const newEmbed = updateQueueEmbedPlayers(embed, remaining);
              const oldEmbed = interaction.message?.embeds?.[0];
              if (oldEmbed && oldEmbed.image?.url && !(newEmbed?.data?.image?.url)) newEmbed.setImage(oldEmbed.image.url);
              await interaction.message.edit(buildQueueMessageEditOptions(
                interaction.message,
                newEmbed,
                [buildQueueEntryActionRow(queueType, effectiveMode, interaction.guild)]
              ));
            } catch (error) {
              console.error('Erro ao remover membros ausentes da fila:', error);
              await interaction.followUp({
                content: 'A aposta não foi criada porque há jogadores ausentes, mas não foi possível limpar a fila.',
                flags: MessageFlags.Ephemeral
              }).catch(() => null);
              return;
            }

            await interaction.followUp({
              content: 'A aposta não foi criada: um ou mais jogadores não estão mais no servidor e foram removidos da fila.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          const thread = await createApostaThread(interaction.guild, threadPlayerIds, betLabel, queueType, effectiveMode, formattedValue, betType);
          if (!thread) {
            await interaction.followUp({ content: 'Erro ao criar tópico de aposta.', flags: MessageFlags.Ephemeral });
            return;
          }

          try {
            const remaining = removeQueuePlayers(players, threadPlayerIds);
            const newEmbed = updateQueueEmbedPlayers(embed, remaining);
            const oldEmbed = interaction.message?.embeds?.[0];
            if (oldEmbed && oldEmbed.image?.url && !(newEmbed?.data?.image?.url)) newEmbed.setImage(oldEmbed.image.url);
            await interaction.message.edit(buildQueueMessageEditOptions(
              interaction.message,
              newEmbed,
              [buildQueueEntryActionRow(queueType, effectiveMode, interaction.guild)]
            ));
          } catch (error) {
            console.error('Erro ao remover jogadores da fila após criar tópico de aposta:', error);
            await interaction.followUp({ content: 'A aposta foi criada, mas não foi possível atualizar a fila original.', flags: MessageFlags.Ephemeral }).catch(() => null);
          }
        };

        if (existing) {
          const currentLabels = getPlayerQueueLabels(existing);

          if (currentLabels.includes(betLabel)) {
            await interaction.reply({ content: 'Você já está nessa opção da fila.', flags: MessageFlags.Ephemeral });
            return;
          }

          existing.label = mergeQueuePlayerLabels(existing.label, betLabel);
          const queueCapacity = getQueueCapacity(effectiveMode);
          const sameOptionPlayers = players.filter(player => getPlayerQueueLabels(player).includes(betLabel));

          if (sameOptionPlayers.length >= queueCapacity) {
            const threadPlayerIds = sameOptionPlayers.slice(0, queueCapacity).map(player => player.id);
            await createBetFromQueuePlayers(threadPlayerIds);
            return;
          }

          await interaction.deferUpdate();
          try {
            const newEmbed = updateQueueEmbedPlayers(embed, players);
            const oldEmbed = interaction.message?.embeds?.[0];
            if (oldEmbed && oldEmbed.image?.url && !(newEmbed?.data?.image?.url)) newEmbed.setImage(oldEmbed.image.url);
            await interaction.message.edit(buildQueueMessageEditOptions(
              interaction.message,
              newEmbed,
              [buildQueueEntryActionRow(queueType, effectiveMode, interaction.guild)]
            ));
          } catch (error) {
            console.error('Erro ao atualizar a fila após adicionar opção para jogador:', error);
            await interaction.followUp({ content: 'Não foi possível atualizar a fila. Tente novamente.', flags: MessageFlags.Ephemeral }).catch(() => null);
          }
          return;
        }

        const queueCapacity = getQueueCapacity(effectiveMode);
        const sameOptionPlayers = players.filter(player => getPlayerQueueLabels(player).includes(betLabel));

        if (sameOptionPlayers.length >= queueCapacity - 1) {
          const threadPlayerIds = [
            ...sameOptionPlayers.slice(0, queueCapacity - 1).map(player => player.id),
            interaction.user.id
          ];
          await createBetFromQueuePlayers(threadPlayerIds);
          return;
        }

        players.push({ id: interaction.user.id, label: betLabel });
        await interaction.deferUpdate();
        try {
          const newEmbed = updateQueueEmbedPlayers(embed, players);
          const oldEmbed = interaction.message?.embeds?.[0];
          if (oldEmbed && oldEmbed.image?.url && !(newEmbed?.data?.image?.url)) newEmbed.setImage(oldEmbed.image.url);
          await interaction.message.edit(buildQueueMessageEditOptions(
            interaction.message,
            newEmbed,
            [buildQueueEntryActionRow(queueType, effectiveMode, interaction.guild)]
          ));
        } catch (error) {
          console.error('Erro ao atualizar fila após entrada de jogador:', error);
          await interaction.followUp({ content: 'Não foi possível atualizar a fila. Tente novamente.', flags: MessageFlags.Ephemeral }).catch(() => null);
        }
        return;
      }
      
      const [action, ticketType] = customId.split(':');
      console.log('Button interaction received:', { interactionId: interaction.id, customId, action, ticketType, guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user?.id });
      const ticketChannel = interaction.channel;
      const ticketData = ticketChannel ? activeTickets.get(ticketChannel.id) : null;

      if (!action) {
        await interaction.reply({ content: 'Este botão não está configurado corretamente.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'ticket-open') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const ticketTypeLabel = getTicketTypeLabel(ticketType);
        let openResult;
        try {
          openResult = await openOrFindTicketForUser(interaction, ticketType);
        } catch (error) {
          console.error(`Erro ao verificar ou abrir ticket do tipo ${ticketType}:`, error);
          await interaction.editReply({ content: 'Não consegui verificar ou abrir seu ticket. Tente novamente em instantes.' });
          return;
        }
        if (openResult.alreadyOpen) {
          await interaction.editReply({ content: `Você já tem um ticket aberto: ${openResult.ticketThread}. Continue seu atendimento por lá.` });
          return;
        }
        if (!openResult.ticketThread) {
          const channelName = getTicketChannelName(ticketType);
          await interaction.editReply({
            content: channelName
              ? `Não encontrei o canal de texto #${channelName}. Crie esse canal para receber tickets dessa opção.`
              : 'Esta opção de atendimento não é válida.'
          });
          return;
        }

        const ticketThread = openResult.ticketThread;

        const ticketStaffRoleIds = getTicketStaffRoleIds(ticketType, supportRoleIds, filasRoleIds);
        const supportMemberIds = new Set();
        await fetchGuildMembers(interaction.guild);
        for (const roleId of ticketStaffRoleIds) {
          const role = interaction.guild.roles.cache.get(roleId);
          if (!role) continue;
          for (const member of role.members.values()) {
            if (member.user.bot) continue;
            supportMemberIds.add(member.id);
          }
        }
        for (const memberId of supportMemberIds) {
          await ticketThread.members.add(memberId).catch(error => {
            console.error(`Erro ao adicionar membro de suporte ${memberId} ao ticket:`, error);
          });
        }

        const requesterMention = `<@${interaction.user.id}>`;
        const ticketEmbed = new EmbedBuilder()
          .setTitle('Ticket aberto')
          .setDescription(`Olá ${requesterMention}, este é o seu ticket de **${ticketTypeLabel}**. Use os botões abaixo para gerenciar o atendimento.`)
          .setColor(0x3498db)
          .addFields(
            { name: 'Tipo', value: ticketTypeLabel, inline: true },
            { name: 'Assumido por', value: 'Ninguém', inline: true },
            { name: 'Dono do ticket', value: requesterMention, inline: true },
            { name: 'Tópico', value: `${ticketThread}`, inline: false }
          );

        const ticketStaffMentions = ticketStaffRoleIds.length > 0 ? ticketStaffRoleIds.map(roleId => `<@&${roleId}>`).join(' ') : 'Nenhum cargo responsável configurado.';
        const ticketMessageContent = `**🔔 Novo ticket aberto por** ${requesterMention}\n**Responsáveis:** ${ticketStaffMentions}\n**Tópico:** ${ticketThread}`;

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket-assume').setLabel('Assumir').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('ticket-leave').setLabel('Sair').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('ticket-add').setLabel('Adicionar').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('ticket-close').setLabel('Finalizar').setStyle(ButtonStyle.Danger)
        );

        const mentionedUsers = [interaction.user.id].filter(Boolean);
        const uniqueUsers = [...new Set(mentionedUsers)];

        await ticketThread.send({
          content: ticketMessageContent,
          embeds: [ticketEmbed],
          components: [buttons],
          allowedMentions: {
            parse: [],
            users: uniqueUsers,
            roles: []
          }
        });

        if (ticketLogsChannelId) {
          await sendLogEmbed(
            interaction.guild,
            ticketLogsChannelId,
            'Ticket aberto',
            `Ticket criado por: <@${interaction.user.id}>\nTipo: ${ticketTypeLabel}\nCanal: ${ticketThread}\nDono do ticket: <@${interaction.user.id}>`,
            0xffffff,
            'tickets'
          );
        }

        await scheduleTicketInactivity(ticketThread.id, ticketThread);

        await interaction.editReply({ content: `✅ Ticket criado: ${ticketThread}` });
        return;
      }

      if (!ticketChannel || (!ticketData && !isTicketChannel(ticketChannel))) {
        await interaction.reply({ content: 'Este botão só funciona dentro de um ticket válido.', flags: MessageFlags.Ephemeral });
        return;
      }

      const ticketState = ticketData || parseTicketStateFromChannel(ticketChannel) || { ownerId: null, assignedTo: null, type: 'suporte' };
      if (!ticketState.ownerId) {
        ticketState.ownerId = getTicketOwnerFromAnnouncement(interaction.message?.content);
      }
      if (ticketState.ownerId) {
        activeTickets.set(ticketChannel.id, ticketState);
      }
      const member = interaction.member;
      const channel = ticketChannel;

      const safeReply = async (options) => {
        try {
          if (interaction.deferred) return await interaction.editReply(options);
          if (interaction.replied) return await interaction.followUp(options);
          return await interaction.reply(options);
        } catch (err) {
          console.error('safeReply error:', err);
          try { await interaction.followUp(options).catch(() => null); } catch {};
        }
      };

      // Para ações que podem demorar, defira a resposta para evitar timeout
      if (['ticket-assume', 'ticket-close'].includes(action) && !interaction.deferred && !interaction.replied) {
        try {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (err) {
          console.error('Falha ao deferir interação:', err);
        }
      }

      switch (action) {

        case 'ticket-assume': {
          if (!hasTicketSupportAccess(member)) {
            await safeReply({ content: 'Você não tem permissão para assumir este ticket.', flags: MessageFlags.Ephemeral });
            return;
          }

          // Bloqueia caso já exista um responsável diferente
          if (ticketState.assignedTo) {
            if (ticketState.assignedTo === member.id) {
              await safeReply({ content: 'Você já está atendendo este ticket.', flags: MessageFlags.Ephemeral });
              return;
            }
            const existingAssignee = await interaction.guild.members.fetch(ticketState.assignedTo).catch(() => null);
            const existingMention = existingAssignee ? `${existingAssignee}` : `<@${ticketState.assignedTo}>`;
            await safeReply({ content: `Este ticket já foi assumido por ${existingMention}.`, flags: MessageFlags.Ephemeral });
            return;
          }

          try {
            await addUserToTicketChannel(channel, member.id);
          } catch (error) {
            console.error('Erro ao adicionar membro ao ticket:', error);
            await safeReply({ content: 'Houve um problema ao alterar as permissões do ticket. Verifique se o bot tem permissão adequada.', flags: MessageFlags.Ephemeral });
            return;
          }

          // Atualiza o estado em memória; threads não oferecem tópico editável.
          ticketState.assignedTo = member.id;
          activeTickets.set(channel.id, ticketState);

          try {
            await setTicketAssigneeTopic(channel, member.id);
          } catch (err) {
            console.error('Erro ao atualizar tópico do ticket com assignedTo:', err);
          }

          let renameFailed = false;
          const supportName = member.displayName || member.user?.username || interaction.user.username;
          const resolvingName = createTicketResolvingName(supportName);
          try {
            await channel.setName(resolvingName);
          } catch (err) {
            renameFailed = true;
            console.error(`Erro ao renomear ticket ${channel.id} após assumir:`, err);
          }

          if (interaction.message?.embeds?.[0]) {
            const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            const fields = updatedEmbed.data.fields ? updatedEmbed.data.fields.filter(field => field.name !== 'Assumido por') : [];
            fields.splice(1, 0, { name: 'Assumido por', value: `${member}`, inline: true });
            updatedEmbed.setFields(fields);
            await interaction.message.edit({ embeds: [updatedEmbed] }).catch(() => null);
          }

          const replyContent = renameFailed
            ? `🎫 ${member} assumiu o atendimento, mas não consegui renomear o canal. Verifique as permissões do bot.`
            : `🎫 ${member} assumiu o atendimento.`;
          await safeReply({ content: replyContent, flags: MessageFlags.Ephemeral });
          await channel.send({ content: ` ${member} agora está atendendo este ticket.` });
          break;
        }

        case 'ticket-leave': {
          if (ticketState.ownerId && interaction.user.id === ticketState.ownerId) {
            await safeReply({ content: 'O dono do ticket não pode usar este botão. Use finalizar para fechar o ticket.', flags: MessageFlags.Ephemeral });
            return;
          }

          try {
            await removeUserFromTicketChannel(channel, interaction.user.id);
          } catch (error) {
            console.error('Erro ao remover usuário do ticket:', error);
            await safeReply({ content: 'Não foi possível remover você do ticket. Verifique as permissões do bot.', flags: MessageFlags.Ephemeral });
            return;
          }

          await safeReply({ content: 'Você saiu do ticket.', flags: MessageFlags.Ephemeral });
          await channel.send({ content: `👋 ${interaction.user.tag} saiu do ticket.` });
          break;
        }

        case 'ticket-add': {
          if (ticketState.ownerId ? interaction.user.id !== ticketState.ownerId && !hasTicketSupportAccess(member) : !hasTicketSupportAccess(member)) {
            await safeReply({ content: 'Apenas o dono do ticket ou um membro de suporte pode adicionar alguém.', flags: MessageFlags.Ephemeral });
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId('ticket-add-modal')
            .setTitle('Adicionar membro ao ticket')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('memberId')
                  .setLabel('ID do membro (somente números)')
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('Ex: 123456789012345678')
                  .setRequired(true)
              )
            );

          await interaction.showModal(modal);
          break;
        }

        case 'ticket-rename': {
          if (!hasTicketSupportAccess(member) && interaction.user.id !== ticketState.ownerId) {
            await safeReply({ content: 'Apenas o dono do ticket ou um membro de suporte pode renomear este canal.', flags: MessageFlags.Ephemeral });
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId('ticket-rename-modal')
            .setTitle('Renomear ticket')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('newChannelName')
                  .setLabel('Novo nome do canal')
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('Ex: atendimento-jordan')
                  .setRequired(true)
                  .setMaxLength(100)
              )
            );

          await interaction.showModal(modal);
          break;
        }

        case 'ticket-close': {
          if (!canCloseTicket(member, interaction.user.id, {
            ownerId,
            guildOwnerId: interaction.guild?.ownerId,
            supportRoleIds,
            auxiliarRoleIds
          })) {
            await safeReply({ content: 'Apenas o suporte pode finalizar esse ticket.', flags: MessageFlags.Ephemeral });
            return;
          }

          await safeReply({ content: '🔒 Ticket sendo finalizado...' });
          await finalizeTicket(channel, interaction.user.id, interaction.user.tag, false);
          break;
        }
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'ff-config-edit-modal') {
        if (!isOwnerAccess(interaction.guild, interaction.user.id)) {
          await interaction.reply({ content: 'Apenas o SOUZA pode alterar a configuração.', flags: MessageFlags.Ephemeral });
          return;
        }

        const banner = interaction.fields.getTextInputValue('banner')?.trim() || '';
        const betValuesRaw = interaction.fields.getTextInputValue('betValues');
        const feeCentsRaw = interaction.fields.getTextInputValue('feeCents');
        if (banner && !isQueueImageUrl(banner)) {
          await interaction.reply({
            content: 'Informe um link HTTP/HTTPS válido e ainda ativo para a thumbnail, ou deixe o campo vazio.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const betValues = sortBetValuesDescending(parseBetValuesInput(betValuesRaw));
        const feeCents = Number.isNaN(parseInt(feeCentsRaw.replace(/[^0-9]/g, ''), 10)) ? 0 : parseInt(feeCentsRaw.replace(/[^0-9]/g, ''), 10);

        if (betValues.length === 0) {
          await interaction.reply({ content: '<:alerta:> Informe valores de aposta válidos.', flags: MessageFlags.Ephemeral });
          return;
        }

        const queueData = getGuildFFQueue(interaction.guild.id);
        queueData.betValues = betValues;
        queueData.feeCents = feeCents;
        queueData.banner = banner;
        for (const qt of Object.keys(ffQueueTypes)) {
          if (!queueData.queues) queueData.queues = {};
          if (!queueData.queues[qt]) queueData.queues[qt] = { settings: getQueueSettings(queueData) };
          queueData.queues[qt].settings.betValues = betValues;
          queueData.queues[qt].settings.feeCents = feeCents;
          queueData.queues[qt].settings.banner = banner;
        }
        saveGuildFFQueue(interaction.guild.id);

        const successEmbed = new EmbedBuilder()
          .setTitle('✅ Configuração atualizada')
          .setDescription('A thumbnail dos painéis auxiliares e as configurações foram atualizadas com sucesso.')
          .addFields(
            { name: 'Thumbnail dos painéis auxiliares', value: banner || 'Nenhuma configurada', inline: false },
            { name: 'Valores das apostas', value: betValues.join(', '), inline: false },
            { name: 'Taxa por entrada', value: `${feeCents} centavos`, inline: true }
          )
          .setColor(0x2ecc71)
          .setTimestamp();

        const queueImage = getQueueImage(banner);
        if (queueImage.url) successEmbed.setThumbnail(queueImage.url);

        await interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId === 'mediador-pix-config-modal') {
        const member = interaction.member;
        const canSavePix = canConfigurePix(member, interaction.user.id, {
          ownerId,
          mediadorIds,
          queueManagerRoleIds,
          supportRoleIds,
          auxiliarRoleIds
        });
        if (!member || !canSavePix) {
          await interaction.reply({ content: 'Apenas o mediador pode salvar o PIX.', flags: MessageFlags.Ephemeral });
          return;
        }

        const bankName = interaction.fields.getTextInputValue('pixBankName')?.trim();
        const pixKey = interaction.fields.getTextInputValue('pixKey')?.trim();
        const message = interaction.fields.getTextInputValue('pixMessage')?.trim();

        if (!bankName || !pixKey || !message) {
          await interaction.reply({ content: 'Informe seu nome completo, a chave Pix e a mensagem.', flags: MessageFlags.Ephemeral });
          return;
        }

        try {
          buildPixPayload({ pixKey, receiverName: bankName });
        } catch (error) {
          await interaction.reply({ content: `Dados inválidos para gerar o Pix: ${error.message}`, flags: MessageFlags.Ephemeral });
          return;
        }

        const previousPixData = mediadorPixData.get(interaction.user.id);
        mediadorPixData.set(interaction.user.id, {
          bankName,
          pixKey: normalizePixKey(pixKey),
          message
        });
        if (!saveMediadorPixData()) {
          if (previousPixData) mediadorPixData.set(interaction.user.id, previousPixData);
          else mediadorPixData.delete(interaction.user.id);
          await interaction.reply({ content: 'Não foi possível salvar os dados do Pix. Tente novamente mais tarde.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.reply({ content: '✅ Dados do PIX cadastrados com sucesso.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId === 'blacklist-check-modal') {
        const userId = interaction.fields.getTextInputValue('blacklistId').replace(/\D/g, '');
        if (!/^[0-9]{17,19}$/.test(userId)) {
          await interaction.reply({ content: 'ID inválido. Use apenas números do Discord.', flags: MessageFlags.Ephemeral });
          return;
        }
        const blacklist = readBlacklist();
        const isBlacklisted = blacklist.includes(userId);
        await interaction.reply({ content: isBlacklisted ? `🚫 O usuário <@${userId}> está na blacklist.` : `✅ O usuário <@${userId}> não está na blacklist.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId === 'blacklist-add-modal') {
        if (!hasSsAnalystAccess(interaction.member)) {
          await interaction.reply({ content: 'Apenas membros com o cargo SSANALISTA_ID podem adicionar usuários na blacklist.', flags: MessageFlags.Ephemeral });
          return;
        }

        const userId = interaction.fields.getTextInputValue('blacklistId').replace(/\D/g, '');
        if (!/^[0-9]{17,19}$/.test(userId)) {
          await interaction.reply({ content: 'ID inválido. Use apenas números do Discord.', flags: MessageFlags.Ephemeral });
          return;
        }
        const blacklist = readBlacklist();
        if (blacklist.includes(userId)) {
          await interaction.reply({ content: 'Este usuário já está na blacklist.', flags: MessageFlags.Ephemeral });
          return;
        }
        blacklist.push(userId);
        if (!saveBlacklist(blacklist)) {
          await interaction.reply({ content: 'Erro ao salvar a blacklist. Tente novamente mais tarde.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: `✅ Usuário <@${userId}> adicionado à blacklist.`, flags: MessageFlags.Ephemeral });
        if (interaction.guild) {
          if (!blacklistLogsChannelId) {
            console.warn('Aviso: canal de logs de blacklist para adição não está configurado.');
          }
          await sendLogEmbed(interaction.guild, blacklistLogsChannelId, 'Blacklist: usuário adicionado', `Usuário: <@${userId}> (${userId})\nAdicionado por: <@${interaction.user.id}>`, 0xffffff, 'blacklist');
        }
        return;
      }

      if (interaction.customId === 'ff-queue-publish-modal') {
        await deferModalReply(interaction, { flags: MessageFlags.Ephemeral }).catch(() => null);

        if (!isOwnerAccess(interaction.guild, interaction.user.id)) {
          await respondToInteraction(interaction, { content: 'Apenas o SOUZA pode publicar filas.', flags: MessageFlags.Ephemeral });
          return;
        }

        const queueModeRaw = interaction.fields.getTextInputValue('queueMode')?.trim() || '';
        const queueTypeRaw = interaction.fields.getTextInputValue('queueType')?.trim() || '';
        const betValuesRaw = interaction.fields.getTextInputValue('betValues')?.trim() || '';
        const normalizedQueueType = String(queueTypeRaw).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const queueTypeMap = { mobile: 'Mobile', emulador: 'Emulador', misto: 'Misto' };
        const queueType = queueTypeMap[normalizedQueueType] || null;
        const mode = normalizeQueueMode(queueModeRaw);
        const displayMode = mode.toUpperCase();

        if (!queueType) {
          await respondToInteraction(interaction, { content: '<:alerta:> Tipo de fila inválido. Use Mobile, Emulador ou Misto.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!['1v1', '2v2', '3v3', '4v4'].includes(queueModeRaw.toLowerCase())) {
          await respondToInteraction(interaction, { content: 'Modo inválido. Use 1v1, 2v2, 3v3 ou 4v4.', flags: MessageFlags.Ephemeral });
          return;
        }

        const queueData = getGuildFFQueue(interaction.guild.id);
        const settings = queueData.queues?.[queueType]?.settings || getQueueSettings(queueData);
        const customBetValues = betValuesRaw ? sortBetValuesDescending(parseBetValuesInput(betValuesRaw)) : null;
        if (betValuesRaw && (!customBetValues.length || customBetValues.some(value => !Number.isFinite(value) || value <= 0))) {
          await respondToInteraction(interaction, {
            content: 'Valores inválidos. Informe números positivos separados por vírgula (ex.: `1, 0.50, 0.25`).',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        let guildChannels;
        try {
          guildChannels = await interaction.guild.channels.fetch();
        } catch (error) {
          console.error(`Erro ao localizar o canal da fila ${queueType}:`, error);
          await respondToInteraction(interaction, {
            content: 'Não foi possível procurar os canais do servidor. Verifique as permissões do bot e tente novamente.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const destinationChannels = findQueueChannelConfigurations(
          [...guildChannels.values()].filter(channel => channel.type === ChannelType.GuildText)
        ).filter(destination => destination.queueType === queueType && destination.mode === mode);
        if (destinationChannels.length === 0) {
          await respondToInteraction(interaction, {
            content: `Não encontrei um canal para ${queueType} ${displayMode}. Nomeie um canal, por exemplo, \`${queueType.toLowerCase()}-${mode}\`.`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (destinationChannels.length > 1) {
          await respondToInteraction(interaction, {
            content: `Encontrei mais de um canal para ${queueType} ${displayMode}. Deixe apenas um canal com o tipo e modo no nome e tente novamente.`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const destinationChannel = destinationChannels[0].channel;
        const queueTitle = `${ffQueueTypes[queueType]?.emoji} Fila ${ffQueueTypes[queueType]?.label || queueType}`.trim();
        const playersEmoji = getQueuePlayersEmoji(interaction.guild);
        const valueEmoji = getQueueValueEmoji(interaction.guild);
        const modeEmoji = getQueueModeEmoji(interaction.guild, queueType);
        const queueThumbnail = buildQueueThumbnail();
        const betValues = customBetValues || sortBetValuesDescending(settings.betValues);
        if (betValues.length === 0) {
          await respondToInteraction(interaction, {
            content: `Não há valores de aposta configurados para ${queueType}. Informe os valores no formulário ou configure-os em .config.`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        let publishedCount = 0;

        try {
          for (const betValue of betValues) {
            const formattedValue = typeof betValue === 'number'
              ? `R$ ${betValue.toFixed(2).replace('.', ',')}`
              : String(betValue);

            const embed = new EmbedBuilder()
              .setTitle(`${queueTitle} | ${displayMode}`)
              .setDescription(`Modo: **${displayMode}**\nTipo: **${queueType}**`)
              .addFields(
                { name: `${modeEmoji ? `${modeEmoji} ` : ''}Modo`, value: `${displayMode}`, inline: true },
                { name: `${valueEmoji} Valor`, value: `${formattedValue}`, inline: true },
                { name: `${playersEmoji} Jogadores`, value: 'Nenhum jogador na fila', inline: false }
              )
              .setColor(0x3498db)
              .setTimestamp();

            applyQueueImageToEmbed(embed, queueThumbnail);

            const buttons = buildQueueEntryActionRow(queueType, mode, interaction.guild);

            await destinationChannel.send({
              embeds: [embed],
              components: [buttons],
              files: queueThumbnail.files
            });
            publishedCount += 1;
          }
        } catch (error) {
          console.error(`Erro ao publicar fila ${queueType} em ${destinationChannel.name}:`, error);
          const partialResult = publishedCount > 0
            ? ` Foram enviadas ${publishedCount} mensagens antes da falha.`
            : '';
          await respondToInteraction(interaction, {
            content: `Não consegui enviar a fila no canal <#${destinationChannel.id}>. Confira se o bot pode ver o canal e enviar mensagens.${partialResult}`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (queueLogsChannelId) {
          await sendLogEmbed(
            interaction.guild,
            queueLogsChannelId,
            'Fila publicada',
            `Fila publicada por: <@${interaction.user.id}>\nTipo: ${queueType}\nCanal: <#${destinationChannel.id}>\nModo: ${mode.toUpperCase()}\nValores: ${betValues.join(', ') || 'Não informado'}`,
            0xffffff,
            'filas'
          );
        }

        await respondToInteraction(interaction, { content: `✅ Fila ${queueType} publicada em <#${destinationChannel.id}>.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId.startsWith('ff-queue-config:')) {
        if (interaction.user.id !== ownerId) {
          await interaction.reply({ content: 'Apenas o SOUZA pode alterar as filas.', flags: MessageFlags.Ephemeral });
          return;
        }

        const [, queueType] = interaction.customId.split(':');
        const queueData = getGuildFFQueue(interaction.guild.id);
        const queue = queueData.queues[queueType];

        const entryAmount = Number.parseInt(interaction.fields.getTextInputValue('entryAmount'), 10);
        const minPlayers = Number.parseInt(interaction.fields.getTextInputValue('minPlayers'), 10);
        const maxPlayers = Number.parseInt(interaction.fields.getTextInputValue('maxPlayers'), 10);

        if (!entryAmount || entryAmount < 1 || !minPlayers || minPlayers < 2 || !maxPlayers || maxPlayers < minPlayers) {
          await interaction.reply({ content: '<:alerta:> Valores inválidos. Verifique os números informados.', flags: MessageFlags.Ephemeral });
          return;
        }

        queue.settings.defaultEntryAmount = entryAmount;
        queue.settings.minPlayersToStart = minPlayers;
        queue.settings.maxPlayersPerQueue = maxPlayers;
        saveGuildFFQueue(interaction.guild.id);

        await interaction.reply({ content: `✅ Configuração da fila ${ffQueueTypes[queueType]?.label || queueType} atualizada.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId === 'ticket-rename-modal') {
        const newName = normalizeTicketName(interaction.fields.getTextInputValue('newChannelName'));
        if (!newName) {
          await interaction.reply({ content: 'Informe um nome válido para o canal.', flags: MessageFlags.Ephemeral });
          return;
        }

        const ticketChannel = interaction.channel;
        if (!isTicketChannel(ticketChannel)) {
          await interaction.reply({ content: 'Este canal não é um ticket válido.', flags: MessageFlags.Ephemeral });
          return;
        }

        const ticketState = activeTickets.get(ticketChannel.id) || parseTicketStateFromChannel(ticketChannel);
        if (!ticketState || (ticketState.ownerId && interaction.user.id !== ticketState.ownerId && !hasTicketSupportAccess(interaction.member))) {
          await interaction.reply({ content: 'Você não tem permissão para renomear este ticket.', flags: MessageFlags.Ephemeral });
          return;
        }

        const safeName = newName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!safeName) {
          await interaction.reply({ content: 'O nome precisa conter pelo menos uma letra ou número.', flags: MessageFlags.Ephemeral });
          return;
        }

        try {
          await ticketChannel.setName(safeName);
          await interaction.reply({ content: `✅ Canal renomeado para ${safeName}.`, flags: MessageFlags.Ephemeral });
        } catch (error) {
          console.error('Erro ao renomear ticket:', error);
          await interaction.reply({ content: 'Não foi possível renomear o canal. Verifique as permissões do bot.', flags: MessageFlags.Ephemeral });
        }
        return;
      }

      if (interaction.customId !== 'ticket-add-modal') return;
      const ticketChannel = interaction.channel;
      if (!isTicketChannel(ticketChannel)) {
        await interaction.reply({ content: 'Este canal não é um ticket válido.', flags: MessageFlags.Ephemeral });
        return;
      }

      const ticketState = activeTickets.get(ticketChannel.id) || parseTicketStateFromChannel(ticketChannel);
      if (!ticketState || (ticketState.ownerId
        ? interaction.user.id !== ticketState.ownerId && !hasTicketSupportAccess(interaction.member)
        : !hasTicketSupportAccess(interaction.member))) {
        await interaction.reply({ content: 'Apenas o dono do ticket ou um membro de suporte pode adicionar alguém.', flags: MessageFlags.Ephemeral });
        return;
      }

      const memberId = interaction.fields.getTextInputValue('memberId').trim();
      if (!/^[0-9]{17,19}$/.test(memberId)) {
        await interaction.reply({ content: 'Membro inválido. Use apenas o ID do usuário, sem menções.', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildMember = await interaction.guild.members.fetch(memberId).catch(() => null);
      if (!guildMember) {
        await interaction.editReply({ content: 'Membro inválido. Use apenas o ID do usuário correto.' });
        return;
      }

      try {
        await addUserToTicketChannel(ticketChannel, guildMember.id);
        await interaction.editReply({ content: `${guildMember.user.tag} foi adicionado ao ticket.` });
        await ticketChannel.send({ content: `➕ ${guildMember.user.tag} foi adicionado ao ticket.` });
      } catch (error) {
        console.error(`Erro ao adicionar ${guildMember.id} ao ticket ${ticketChannel.id}:`, error);
        await interaction.editReply({
          content: 'Não foi possível adicionar esse membro ao ticket. Verifique as permissões do bot e tente novamente.'
        });
      }
    }
  } catch (error) {
    const interactionId = interaction?.customId ?? interaction?.commandName ?? 'unknown';
    const errorCode = error?.code ?? error?.rawError?.code;
    const status = error?.status ?? error?.rawError?.status;
    const errorMessage = [error?.message, error?.rawError?.message].filter(Boolean).join(' ');
    const isStaleInteraction = errorCode === 10008 || errorCode === 10062 || status === 404 || /unknown interaction|unknown message/i.test(errorMessage);

    if (!isStaleInteraction) {
      console.error('Erro ao processar interação', { type: interaction?.type, id: interactionId, guildId: interaction?.guildId, channelId: interaction?.channelId }, error);
    }

    try {
      if (interaction.replied || interaction.deferred) {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply({ content: 'Ocorreu um erro ao processar a interação.' }).catch(() => null);
        } else {
          await interaction.followUp({ content: 'Ocorreu um erro ao processar a interação.', flags: MessageFlags.Ephemeral }).catch(() => null);
        }
      } else if (!isStaleInteraction) {
        await interaction.reply({ content: 'Ocorreu um erro ao processar a interação.', flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    } catch (err) {
      console.error('Falha ao notificar usuário sobre erro de interação:', err);
    }
  }
});

client.on(Events.GuildMemberAdd, async member => {
  const roleIds = autoroleRoles.get(member.guild.id);
  if (!Array.isArray(roleIds) || roleIds.length === 0) return;

  const assignableRoles = roleIds.filter(roleId => member.guild.roles.cache.has(roleId));
  if (assignableRoles.length === 0) return;

  try {
    await member.roles.add(assignableRoles, 'Auto role configurado');
  } catch (error) {
    console.error(`Erro ao atribuir auto role para ${member.user.tag}:`, error);
  }
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  if (message.channel.id === apostasChannelId && message.type === MessageType.ThreadCreated && message.content?.includes('aguardando')) {
    await message.delete().catch(() => null);
    return;
  }

  if ((message.channel.type === ChannelType.GuildText || (typeof message.channel.isThread === 'function' && message.channel.isThread())) && activeTickets.has(message.channel.id)) {
    await scheduleTicketInactivity(message.channel.id, message.channel);
  }

  const content = message.content.trim();

    let threadMeta = apostaThreadMeta.get(message.channel.id);
    if (!threadMeta && typeof message.channel.isThread === 'function' && message.channel.isThread()) {
      threadMeta = await restoreBetThreadMeta(message.channel);
    }
    // allow messages in parent channel by mapping author to their open aposta thread
    let targetThreadId = message.channel.id;
    if (!threadMeta) {
      for (const [tid, meta] of apostaThreadMeta.entries()) {
        try {
          if (!meta || !meta.playerIds) continue;
          if (meta.playerIds.map(String).includes(String(message.author.id))) {
            // prefer threads that still exist
            const ch = await client.channels.fetch(tid).catch(() => null);
            if (ch) {
              threadMeta = meta;
              targetThreadId = tid;
              break;
            }
          }
        } catch (e) {}
      }
    }

    const isPlayerInTargetThread = threadMeta
      && message.channel.id === targetThreadId
      && Array.isArray(threadMeta.playerIds)
      && threadMeta.playerIds.map(String).includes(String(message.author.id));
    if (
      isPlayerInTargetThread
      && content
      && containsPixKeyInText(content)
      && !isBetPaymentChannelName(message.channel.name)
    ) {
      let messageRemoved = false;
      try {
        await message.delete();
        messageRemoved = true;
      } catch (error) {
        console.error(`Não foi possível remover a chave Pix enviada antes do pagamento na fila ${message.channel.id}:`, error);
      }

      try {
        await message.channel.send(
          `<@${message.author.id}> por segurança, não envie chaves Pix antes de a fila entrar em pagamento.${messageRemoved ? ' A mensagem foi removida.' : ' Não conseguimos remover a mensagem; apague-a manualmente.'}`
        );
      } catch (error) {
        console.error(`Não foi possível avisar o jogador sobre a chave Pix na fila ${message.channel.id}:`, error);
      }
      return;
    }

    if (threadMeta && content && !content.startsWith('.')) {
        // ensure we have a full GuildMember for permission checks (threads may not include member in cache)
        let member = message.member;
        if (!member && message.guild) {
          member = await message.guild.members.fetch(message.author.id).catch(() => null);
        }

        // allow mediadores, queue managers or players in the thread to set room credentials
        const isPlayer = Array.isArray(threadMeta.playerIds) && threadMeta.playerIds.map(String).includes(String(message.author.id));
        if (threadMeta.roomCreated && message.channel.id === targetThreadId && isPlayer) {
          const pixKey = findPixKeyInText(content);
          if (pixKey) {
            try {
              await message.reply(await buildPixQrReply(pixKey));
            } catch (error) {
              console.error(`Erro ao gerar QR Pix da mensagem ${message.id}:`, error);
              await message.reply('Não foi possível gerar o QR Pix. Verifique a chave informada e tente novamente.');
            }
            return;
          }
        }

        const canManageRoom = hasMediadorAccess(message.author.id) || hasQueueManagerRole(member) || isPlayer;
        if (!canManageRoom) return;

    const explicitCredentials = extractRoomCredentials(content);
    const codes = [...new Set(Array.from(content.matchAll(/(\d{2,11})/g), m => m[1]))];
    if (codes.length === 0 && !explicitCredentials.roomId && !explicitCredentials.roomPassword) {
      return;
    }

    let roomId = threadMeta.pendingRoomId || null;
    let roomPassword = threadMeta.pendingRoomPassword || null;
    const idFromMessage = explicitCredentials.roomId || codes.find(code => code.length >= 6 && code.length <= 11) || null;
    const     passwordFromMessage = explicitCredentials.roomPassword || codes.find(code => code.length >= 2 && code.length <= 6 && code !== idFromMessage) || null;

    if (idFromMessage) {
      roomId = idFromMessage;
    }
    if (passwordFromMessage) {
      roomPassword = passwordFromMessage;
    }

    // combine with stored pending values across messages
    if (!roomId && threadMeta.pendingRoomId) {
      roomId = threadMeta.pendingRoomId;
    }
    if (!roomPassword && threadMeta.pendingRoomPassword) {
      roomPassword = threadMeta.pendingRoomPassword;
    }

    threadMeta.pendingRoomId = roomId;
    threadMeta.pendingRoomPassword = roomPassword;
    apostaThreadMeta.set(targetThreadId, threadMeta);

    if (roomId && roomPassword) {
      if (!threadMeta.pixReleased) {
        await message.reply('Recebi o ID e a senha, mas o PIX desta aposta ainda não foi liberado pelo mediador.');
        return;
      }
        // Depuração e feedback ao usuário: se detectamos números mas não conseguimos atribuir id/senha, logue o contexto e oriente o autor
        if ((codes.length > 0 || explicitCredentials.roomId || explicitCredentials.roomPassword) && !(roomId && roomPassword)) {
          try {
              console.log('Room credential parsing debug:', {
                authorId: message.author.id,
                channelId: message.channel.id,
                targetThreadId,
                threadHasMeta: Boolean(threadMeta),
                canManageRoom: canManageRoom,
                contentPreview: content.slice(0, 120),
                explicitCredentials,
                codes
              });
          } catch (e) {}

          // Provide helpful guidance to the user so they can resend correctly
          try {
            if (!threadMeta) {
              await message.reply('Detectei números na mensagem, mas não consegui processá-los aqui. Envie o ID e a senha dentro do tópico/thread da aposta (onde a sala foi criada).');
            } else if (!canManageRoom) {
              await message.reply('Detectei números, mas você não tem permissão para configurar a sala aqui. Peça a um mediador ou gerente para enviar o ID e a senha.');
            } else if (!roomId || !roomPassword) {
              await message.reply('Detectei números, mas não consegui identificar corretamente o ID e a senha. Envie ambos no formato: `70065428 123456` (ID com 6-11 dígitos e senha com 2-6 dígitos).');
            }
          } catch (e) {}
        }

      const threadMediadorId = assignedBetAdministrators.get(targetThreadId) || null;
      const canCreateRoomPanel = message.author.id === threadMediadorId || message.author.id === ownerId || hasQueueManagerRole(member);
      if (canCreateRoomPanel) {
        const targetChannel = await client.channels.fetch(targetThreadId).catch(() => null) || message.channel;

        try {
          await publishRoomPanel({ targetChannel, threadMeta, roomId, roomPassword });
        } catch (error) {
          console.error(`Erro ao publicar o painel da sala no tópico ${targetThreadId}:`, error);
        }
        apostaThreadMeta.set(targetThreadId, threadMeta);
        return;
      }

      return;
    }

    if (roomId && !roomPassword) {
      return;
    }

    if (roomPassword && !roomId) {
      return;
    }
  }

  if (!content.startsWith('.')) return;

  const [commandToken, ...args] = content.slice(1).split(/\s+/);
  const command = commandToken?.toLowerCase() ?? '';
  const text = content.slice(1 + commandToken.length).replace(/^\s*/, '');

  if (command === 'v' || command === 'w') {
    if (!hasMediadorAccess(message.author.id)) {
      await message.reply('Apenas mediadores autorizados podem registrar o resultado da aposta.');
      return;
    }

    if (typeof message.channel.isThread !== 'function' || !message.channel.isThread()) {
      await message.reply('Use esse comando respondendo à mensagem do vencedor dentro do tópico da aposta.');
      return;
    }

    let threadMeta = apostaThreadMeta.get(message.channel.id);
    if (!threadMeta || !Array.isArray(threadMeta.playerIds)) {
      let threadMessages;
      try {
        threadMessages = await fetchAllChannelMessages(message.channel, 1000);
      } catch (error) {
        console.error(`Erro ao recuperar jogadores da aposta no tópico ${message.channel.id}:`, error);
        await message.reply('Não consegui consultar as mensagens do tópico para identificar os jogadores.');
        return;
      }

      const playerIds = [...new Set(
        threadMessages
          .flatMap(threadMessage => parseQueuePlayersFromEmbed(threadMessage.embeds?.[0]))
          .map(player => String(player.id))
      )];
      if (playerIds.length === 2) {
        threadMeta = {
          playerIds,
          resultRecorded: hasRecordedBetResult(threadMessages)
        };
        apostaThreadMeta.set(message.channel.id, threadMeta);
      }
    }

    if (!threadMeta || !Array.isArray(threadMeta.playerIds) || threadMeta.playerIds.length !== 2) {
      await message.reply('Este tópico não tem uma aposta válida para registrar o resultado.');
      return;
    }

    if (threadMeta.resultRecorded) {
      await message.reply('O resultado desta aposta já foi registrado.');
      return;
    }

    if (!message.reference?.messageId) {
      await message.reply(`Responda à mensagem do vencedor e use \`.${command}\`.`);
      return;
    }

    let repliedMessage;
    try {
      repliedMessage = await message.fetchReference();
    } catch (error) {
      console.error('Erro ao buscar mensagem respondida pelo comando de resultado:', error);
      await message.reply('Não consegui localizar a mensagem respondida. Tente novamente no tópico da aposta.');
      return;
    }

    if (String(repliedMessage.channelId) !== String(message.channel.id)) {
      await message.reply('A mensagem respondida precisa estar neste tópico da aposta.');
      return;
    }

    const winnerId = String(repliedMessage.author.id);
    const participantIds = threadMeta.playerIds.map(String);
    if (!participantIds.includes(winnerId)) {
      await message.reply('A mensagem respondida precisa ser de um dos jogadores desta aposta.');
      return;
    }

    const loserId = participantIds.find(id => id !== winnerId);
    if (!loserId) {
      await message.reply('Não foi possível identificar o outro jogador da aposta.');
      return;
    }

    const resultThreadMeta = apostaThreadMeta.get(message.channel.id) || threadMeta;
    if (resultThreadMeta.resultRecorded) {
      await message.reply('O resultado desta aposta já foi registrado.');
      return;
    }

    resultThreadMeta.resultRecorded = true;
    resultThreadMeta.resultType = command === 'w' ? 'wo' : 'normal';
    apostaThreadMeta.set(message.channel.id, resultThreadMeta);

    const awardCoins = command === 'v';
    recordWin(winnerId, awardCoins);
    recordLoss(loserId);

    const assignedMediadorId = assignedBetAdministrators.get(message.channel.id);
    if (assignedMediadorId) {
      const mediadorStats = mediadorProfile.getMediadorProfileStats(assignedMediadorId);
      mediadorProfile.recordMediadorCompletedQueue(mediadorStats);
    }

    const winnerMention = `<@${winnerId}>`;
    const loserMention = `<@${loserId}>`;
    const resultGuild = message.guild;
    const resultModeEmoji = getQueueModeEmoji(resultGuild, resultThreadMeta.queueType);
    const resultMode = [
      resultThreadMeta.mode ? String(resultThreadMeta.mode).toUpperCase() : null,
      resultThreadMeta.queueType ? ffQueueTypes[resultThreadMeta.queueType]?.label || resultThreadMeta.queueType : null
    ].filter(Boolean).join(' ');
    const resultBetCents = Number(resultThreadMeta.betCents) || 0;
    const resultFeeCents = Number(resultThreadMeta.feeCents) || 0;
    const resultEmbed = new EmbedBuilder()
      .setTitle(command === 'w' ? 'Resultado da Aposta • W.O.' : 'Resultado da Aposta')
      .setDescription(command === 'w'
        ? 'A vitória foi registrada por **W.O.**'
        : 'A vitória foi registrada com sucesso.')
      .addFields(
        {
          name: `${getGuildEmojiMarkup(resultGuild, 'CheckV') || '✅'} Vencedor`,
          value: winnerMention,
          inline: true
        },
        {
          name: `${getGuildEmojiMarkup(resultGuild, 'errado') || '❌'} Perdedor`,
          value: loserMention,
          inline: true
        },
        {
          name: `${getGuildEmojiMarkup(resultGuild, 'aaaaapostas') || '👥'} Jogadores`,
          value: `${winnerMention} • ${loserMention}`,
          inline: false
        },
        {
          name: `${resultModeEmoji || getGuildEmojiMarkup(resultGuild, 'mobile') || '📱'} Modo`,
          value: resultMode || 'Não informado',
          inline: true
        },
        {
          name: `${getQueueValueEmoji(resultGuild)} Valor por jogador`,
          value: resultBetCents + resultFeeCents > 0
            ? formatCentsToCurrency(resultBetCents + resultFeeCents)
            : resultThreadMeta.betValueText || 'Não informado',
          inline: true
        },
        {
          name: `${getGuildEmojiMarkup(resultGuild, 'dinheiro') || '🪙'} Recompensa`,
          value: awardCoins ? '+1 vitória e +1 coin' : '+1 vitória, sem coin',
          inline: true
        }
      )
      .setColor(command === 'w' ? 0xf1c40f : 0x2ecc71)
      .setFooter({ text: `Resultado registrado por ${message.author.tag}` })
      .setTimestamp();
    const deleteThreadRow = new ActionRowBuilder().addComponents(
      applyGuildEmojiToButton(
        new ButtonBuilder()
          .setCustomId('result-delete-thread')
          .setLabel('Finalizar Aposta')
          .setStyle(ButtonStyle.Danger),
        resultGuild,
        'red_deletar_crz'
      )
    );
    await message.channel.send({ embeds: [resultEmbed], components: [deleteThreadRow] });

    if (message.guild) {
      await sendBetResultLogs(
        message.guild,
        command === 'w' ? 'Aposta finalizada por W.O' : 'Aposta finalizada',
        `Vencedor: ${winnerMention}\nPerdedor: ${loserMention}\nMediador: <@${message.author.id}>`,
        0xffffff,
        message.channel.id,
        true
      );
    }

    return;
  }

  if (command === 'gp') {
    if (!hasAllowedQueueRole(message.member) && !hasQueueManagerRole(message.member)) {
      await message.reply('Apenas mediadores podem usar o comando `.gp`.');
      return;
    }

    let pixKey = args[0]?.trim();
    let amountText = args[1]?.trim();
    let amountCents;
    const amountPattern = /^\d{1,7}(?:[,.]\d{1,2})?$/;

    if (args.length > 2) {
      await message.reply('Use `.gp <chave-pix> [valor-em-reais]` ou responda à mensagem com a chave Pix usando `.gp [valor-em-reais]`.\nExemplo: `.gp email@exemplo.com 25,50`');
      return;
    }

    if (message.reference?.messageId && (!pixKey || (args.length === 1 && amountPattern.test(pixKey)))) {
      if (pixKey) amountText = pixKey;
      let repliedMessage;
      try {
        repliedMessage = await message.fetchReference();
      } catch (error) {
        console.error('Erro ao buscar mensagem respondida pelo comando .gp:', error);
        await message.reply('Não consegui localizar a mensagem respondida. Tente novamente.');
        return;
      }

      if (String(repliedMessage.channelId) !== String(message.channel.id)) {
        await message.reply('A mensagem respondida precisa estar neste canal.');
        return;
      }

      pixKey = repliedMessage.content.trim();
      if (!pixKey) {
        await message.reply('A mensagem respondida precisa conter a chave Pix em texto.');
        return;
      }
    }

    if (!pixKey) {
      await message.reply('Use `.gp <chave-pix> [valor-em-reais]` ou responda à mensagem com a chave Pix usando `.gp [valor-em-reais]`.\nExemplo: `.gp email@exemplo.com 25,50`');
      return;
    }

    if (amountText) {
      const normalizedAmount = amountText.replace(',', '.');
      if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalizedAmount)) {
        await message.reply('Valor inválido. Informe um valor positivo, por exemplo `25,50`.');
        return;
      }
      amountCents = Math.round(Number(normalizedAmount) * 100);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        await message.reply('Valor inválido. Informe um valor positivo.');
        return;
      }
    }

    try {
      await message.reply(await buildPixQrReply(pixKey, amountCents));
    } catch (error) {
      console.error('Erro ao gerar QR Pix pelo comando .gp:', error);
      await message.reply('Não foi possível gerar o QR Pix. Verifique a chave informada e tente novamente.');
    }
    return;
  }

  if (command === 'meet') {
    await handleMeetCommand(message, hasMediadorAccess(message.author.id));
    return;
  }

  if (command === 'aux' || command === 'med') {
    const commandLabel = `.${command}`;
    await message.delete().catch(() => null);

    const canUseAux = hasMediadorAccess(message.author.id) || hasAllowedQueueRole(message.member);
    if (!canUseAux) {
      await message.channel.send('Você não tem autorização para usar esse comando.').catch(() => null);
      return;
    }

    const channel = message.channel;
    const allowedAuxThreadNames = getAllowedAuxThreadNames();
    const channelName = channel?.name?.toLowerCase() || '';
    const isAllowedAuxChannel = allowedAuxThreadNames.some(name => channelName === name.toLowerCase()) || isBetPaymentChannelName(channelName);

    if (!channel || !channel.name || !isAllowedAuxChannel) {
      await message.channel.send('Você precisa estar em um canal ou tópico de aposta.').catch(() => null);
      return;
    }

    if (!message.guild) {
      await message.channel.send(`Comando \`${commandLabel}\` só pode ser usado em um servidor.`).catch(() => null);
      return;
    }

    let threadMeta = apostaThreadMeta.get(channel.id);
    if (!threadMeta && typeof channel.isThread === 'function' && channel.isThread()) {
      threadMeta = await restoreBetThreadMeta(channel);
    }

    const queueParticipants = buildQueueParticipants(threadMeta?.playerIds, threadMeta?.playerNames);
    if (queueParticipants.length !== 2) {
      await message.channel.send(`Não foi possível identificar os dois jogadores registrados nesta aposta para o \`${commandLabel}\`. Confira se você está no tópico correto e tente novamente.`).catch(() => null);
      return;
    }

    const participantNames = await Promise.all(queueParticipants.map(async participant => {
      let member = channel.guild.members.cache.get(participant.id);
      if (!member) {
        try {
          member = await channel.guild.members.fetch(participant.id);
        } catch (error) {
          console.warn(`Não foi possível buscar o jogador ${participant.id} para o painel ${commandLabel}:`, error);
        }
      }
      return participant.name || member?.displayName || member?.user?.username || participant.id;
    }));

    const actionOptions = [
      { label: 'Definir Vencedor', value: 'winner', description: 'Seleciona o vencedor e ganha 1 coin' },
      { label: 'Definir Vencedor por W.O', value: 'wo', description: 'Seleciona o vencedor sem coin' },
      { label: 'Finalizar aposta', value: 'finalizar', description: 'Exclui o tópico em 3 segundos' },
      { label: 'Revanche', value: 'revanche', description: 'Opção em breve' }
    ];

    const actionMenu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('aux-action-select')
        .setPlaceholder('Escolha a ação da aposta')
        .addOptions(actionOptions)
    );

    const auxEmbed = new EmbedBuilder()
      .setTitle(`🎯 Painel de ${commandLabel}`)
      .setDescription('Escolha uma ação para continuar com a aposta.')
      .addFields(
        { name: 'Status', value: '⏳ Aguardando ação...', inline: false }
      )
      .setColor(0x3498db)
      .setTimestamp();

    const replyMessage = await message.channel.send({ embeds: [auxEmbed], components: [actionMenu] });
    auxSelections.set(replyMessage.id, {
      participants: queueParticipants.map(participant => participant.id),
      participantNames,
      commandLabel,
      targetChannelId: channel.id
    });
    return;
  }

  if (command === 'pix') {
    const member = message.member;
    const canUsePixCommand = canConfigurePix(member, message.author.id, {
      ownerId,
      mediadorIds,
      queueManagerRoleIds,
      supportRoleIds,
      auxiliarRoleIds
    });

    if (!canUsePixCommand) {
      await message.reply('Apenas o owner ou um mediador autorizado pode usar o comando .pix.');
      return;
    }

    if (!mediadorIds.length) {
      await message.reply('Nenhum `MEDIADOR_ID` foi configurado no ambiente.');
      return;
    }

    await message.delete().catch(() => null);

    const pixRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('mediador-pix-config')
        .setLabel('Cadastrar Chave')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('mediador-pix-check')
        .setLabel('Verificar Cadastro')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('mediador-pix-admin-check')
        .setLabel('Verificar de Adm')
        .setStyle(ButtonStyle.Secondary)
    );

    await message.channel.send({ embeds: [buildMediadorPixPanel()], components: [pixRow] });
    return;
  }

  if (command === 'mediador') {
    const member = message.member;

    if (!member || (!hasAllowedQueueRole(member) && !hasQueueManagerRole(member))) {
      await message.reply('Apenas mediadores ou cargos autorizados podem usar este comando.');
      return;
    }

    await message.delete().catch(() => null);

    const actionRow = buildMediadorActionRow();
    await message.channel.send({ embeds: [buildMediadorPanelEmbed()], components: [actionRow] });
    return;
  }

  if (command === 'ticket') {
    await message.delete().catch(() => null);
    await message.channel.send(buildTicketPanelPayload(message.guild.id));
    return;
  }

  if (command === 'blackl') {
    await message.delete().catch(() => null);

    const embed = new EmbedBuilder()
      .setTitle('Painel de consulta BlackList')
      .setDescription('Bem-vindo ao painel de blacklist. Use os botões abaixo para verificar ou adicionar um usuário à blacklist.')
      .setColor(0x3498db)
      .addFields(
        { name: 'Ações', value: 'Use os botões abaixo para consultar ou adicionar IDs à blacklist.', inline: false }
      )
      .setTimestamp();

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('blacklist-check')
        .setLabel('Verificar ID')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('blacklist-add')
        .setLabel('Adicionar Blacklist')
        .setStyle(ButtonStyle.Secondary)
    );

    await message.channel.send({ embeds: [embed], components: [actionRow] });
    return;
  }

  if (command === 'rblack') {
    if (!hasSsAnalystAccess(message.member)) {
      await message.reply('Você não tem autorização para usar este comando.');
      return;
    }

    const userId = args[0]?.replace(/\D/g, '');
    if (!userId || !/^[0-9]{17,19}$/.test(userId)) {
      await message.reply('Use `.rblack <id>` com um ID válido do Discord.');
      return;
    }

    const blacklist = readBlacklist();
    if (!blacklist.includes(userId)) {
      await message.reply(`❌ O usuário <@${userId}> não está na blacklist.`);
      return;
    }

    const updatedBlacklist = blacklist.filter(id => id !== userId);
    if (!saveBlacklist(updatedBlacklist)) {
      await message.reply('Erro ao salvar a blacklist. Tente novamente mais tarde.');
      return;
    }

    await message.reply(`✅ Usuário <@${userId}> removido da blacklist.`);
    if (message.guild) {
      if (!blacklistLogsChannelId) {
        console.warn('Aviso: canal de logs de blacklist para remoção não está configurado.');
      }
      await sendLogEmbed(message.guild, blacklistLogsChannelId, 'Blacklist: usuário removido', `Usuário: <@${userId}> (${userId})\nRemovido por: <@${message.author.id}>`, 0xffffff, 'blacklist');
    }
    return;
  }

  if (command === 'tmob') {
    const channel = message.channel;
    const channelName = channel?.name?.toLowerCase() || '';
    const isAllowedChannel = isBetPaymentChannelName(channelName);

    if (!hasAllowedQueueRole(message.member)) {
      await message.reply('Você não tem autorização para usar este comando.');
      return;
    }

    if (!isAllowedChannel) {
      await message.reply('Este comando só funciona em canais de aposta com nome `💸pagar-*`.');
      return;
    }

    if (!teladorChannelId) {
      await message.reply('O canal de telador não está configurado.');
      return;
    }

    const teladorChannel = await client.channels.fetch(teladorChannelId).catch(() => null);
    if (!teladorChannel || !teladorChannel.isTextBased()) {
      await message.reply('O canal de telador configurado é inválido.');
      return;
    }

    await message.delete().catch(() => null);

    const teladorEmbed = new EmbedBuilder()
      .setTitle('Solicitação de Telagem')
      .setDescription(`Uma nova telagem foi solicitada no canal <#${channel.id}>. Clique em Aceitar Telagem para assumir.`)
      .addFields(
        { name: 'Canal de aposta', value: `${channel}`, inline: false },
        { name: 'Solicitado por', value: `<@${message.author.id}>`, inline: false }
      )
      .setColor(0x3498db)
      .setTimestamp();

    const actionRow = new ActionRowBuilder().addComponents(
      applyGuildEmojiToButton(
        new ButtonBuilder()
          .setCustomId(`tmob-accept:${channel.id}`)
          .setLabel('Aceitar Telagem')
          .setStyle(ButtonStyle.Success),
        message.guild,
        'CheckV'
      )
    );

    await teladorChannel.send({ embeds: [teladorEmbed], components: [actionRow] });
    await message.channel.send({ content: 'Solicitação de telagem enviada ao canal de telador.' }).catch(() => null);
    return;
  }

  if (command === 'ssmob') {
    const channel = message.channel;
    const channelName = channel?.name?.toLowerCase() || '';
    const isAllowedChannel = isBetPaymentChannelName(channelName);

    if (!hasAllowedQueueRole(message.member)) {
      await message.reply('Você não tem autorização para usar este comando.');
      return;
    }

    if (!isAllowedChannel) {
      await message.reply('Este comando só funciona em canais de aposta com nome `💸pagar-*`.');
      return;
    }

    if (!ssmobChannelId) {
      await message.reply('O canal de SS não está configurado.');
      return;
    }

    const ssmobChannel = await client.channels.fetch(ssmobChannelId).catch(() => null);
    if (!ssmobChannel || !ssmobChannel.isTextBased()) {
      await message.reply('O canal de SS configurado é inválido.');
      return;
    }

    await message.delete().catch(() => null);

    const ssmobEmbed = new EmbedBuilder()
      .setTitle('Solicitação de SS')
      .setDescription(`Uma nova solicitação de SS foi solicitada no canal <#${channel.id}>. Clique em Aceitar Análise para assumir.`)
      .addFields(
        { name: 'Canal de aposta', value: `${channel}`, inline: false },
        { name: 'Solicitado por', value: `<@${message.author.id}>`, inline: false }
      )
      .setColor(0x3498db)
      .setTimestamp();

    const actionRow = new ActionRowBuilder().addComponents(
      applyGuildEmojiToButton(
        new ButtonBuilder()
          .setCustomId(`ssmob-accept:${channel.id}`)
          .setLabel('Aceitar Análise')
          .setStyle(ButtonStyle.Success),
        message.guild,
        'CheckV'
      )
    );

    await ssmobChannel.send({ embeds: [ssmobEmbed], components: [actionRow] }).catch(() => null);
    await message.channel.send({ content: 'Solicitação de SS enviada ao canal de SS.' }).catch(() => null);
    return;
  }

  if (command === 'p') {
    let target = message.author;
    if (message.mentions.users.size > 0) {
      target = message.mentions.users.first();
    } else if (args[0]) {
      const userId = args[0].replace(/[^0-9]/g, '');
      const fetchedUser = await client.users.fetch(userId).catch(() => null);
      if (fetchedUser) target = fetchedUser;
    }

    const profile = getUserRecord(target.id);
    const performance = getWinRatePercentage(profile).toLocaleString('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
    const profileEmbed = new EmbedBuilder()
      .setTitle(`Perfil de ${target.username}`)
      .setDescription(`Estatísticas de ${target}.`)
      .addFields(
        { name: 'Vitórias', value: `${profile.victories}`, inline: true },
        { name: 'Derrotas', value: `${profile.defeats}`, inline: true },
        { name: 'Desempenho', value: `${performance}%`, inline: true },
        { name: 'Vitórias consecutivas', value: `${profile.streak}`, inline: true },
        { name: 'Coins', value: `${profile.coins}`, inline: true }
      )
      .setColor(0x3498db)
      .setTimestamp();

    await message.reply({ embeds: [profileEmbed] });
    return;
  }

  if (command === 'rank') {
    await message.delete().catch(() => null);
    const thumbnail = getQueueThumbnail(message.guild.id);
    await message.channel.send({
      embeds: [buildRankPanelEmbed(message.author, thumbnail.url)],
      components: [buildRankPanelRow(message.guild)],
      files: thumbnail.files
    });
    return;
  }

  if (command === 'perfilmed') {
    const member = message.member;
    if (!member || !hasAllowedQueueRole(member)) {
      await message.reply('Apenas mediadores podem usar esse comando.');
      return;
    }

    const targetUser = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0].replace(/\D/g, '')).catch(() => null) : null) || message.author;
    const target = targetUser || message.author;
    await message.delete().catch(() => null);
    await message.channel.send({ embeds: [buildMediadorProfileEmbed(target, target.id)] });
    return;
  }

  if (command === 'rankmed') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply('Apenas o SOUZA pode usar o comando.');
      return;
    }

    await message.delete().catch(() => null);
    const entries = mediadorProfile.getMediadorRankingEntries();
    await message.channel.send({ embeds: [buildMediadorRankMedEmbed(entries)] });
    return;
  }

  if (command === 'perfiltld') {
    if (!hasTeladorRole(message.member)) {
      await message.reply('Apenas TELADORES podem usar esse comando.');
      return;
    }

    const targetUser = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0].replace(/\D/g, '')).catch(() => null) : null) || message.author;
    const target = targetUser || message.author;
    await message.delete().catch(() => null);
    await message.channel.send({ embeds: [buildTeladorProfileEmbed(target, target.id)] });
    return;
  }

  if (command === 'ranktld') {
    if (!hasTeladorRole(message.member)) {
      await message.reply('Apenas os Teladores podem usar o comando.');
      return;
    }

    await message.delete().catch(() => null);
    const entries = teladorProfile.getTeladorRankingEntries();
    await message.channel.send({ embeds: [buildTeladorRankTldEmbed(entries)] });
    return;
  }

  if (command === 'logs') {
    if (!hasQueueLogAccess(message.member, message.author.id)) {
      await message.reply('Apenas o suporte e o owner configurado podem usar este comando.');
      return;
    }

    const targetUser = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0].replace(/\D/g, '')).catch(() => null) : null);
    if (!targetUser) {
      await message.reply('Use `.logs @usuario` para consultar filas ou tickets de alguém.');
      return;
    }

    await message.delete().catch(() => null);
    const queueEmoji = message.guild?.emojis.cache.find(emoji => emoji.name === 'salas~1');
    const ticketEmoji = message.guild?.emojis.cache.find(emoji => emoji.name === 'suporte');
    const logsMenuMessage = await message.channel.send(buildUserLogsHome(targetUser, queueEmoji, ticketEmoji));
    userLogQuerySelections.set(logsMenuMessage.id, {
      requesterId: message.author.id,
      targetUserId: targetUser.id,
      targetUsername: targetUser.username,
      channelId: message.channel.id,
      queueEntries: [],
      ticketEntries: []
    });
    return;
  }

  if (command === 'perfilss') {
    if (!hasSsAnalystAccess(message.member)) {
      await message.reply('Apenas SS pode usar o comando.');
      return;
    }

    const targetUser = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0].replace(/\D/g, '')).catch(() => null) : null) || message.author;
    const target = targetUser || message.author;
    const entries = analistaProfile.getAnalistaRankingEntries();
    const allIds = entries.map(entry => entry.userId).filter(Boolean);
    const rankMentions = await buildAnalistaRankMentions(allIds);

    await message.delete().catch(() => null);
    await message.channel.send({
      embeds: [buildAnalistaProfileEmbed(target, target.id, rankMentions)],
      allowedMentions: { parse: ['users'], roles: [] }
    });
    return;
  }

  if (command === 'rankss') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply('Apenas o SOUZA pode usar o comando.');
      return;
    }

    await message.delete().catch(() => null);
    const entries = analistaProfile.getAnalistaRankingEntries();
    const allIds = entries.map(entry => entry.userId).filter(Boolean);
    const rankMentions = await buildAnalistaRankMentions(allIds);

    await message.channel.send({
      embeds: [buildAnalistaRankEmbed(entries, rankMentions)],
      allowedMentions: { parse: ['users'], roles: [] }
    });
    return;
  }

  if (command === 'comandos') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      return;
    }

    const commandsList = [
      '.aux - abre painel para selecionar vencedor e perdedor',
      '.med - abre o mesmo painel de aposta do .aux',
      '.p [@usuario] - mostra perfil do usuário com vitórias, derrotas, desempenho (%), streak e coins',
      '.rank - mostra ranking de vitórias com navegação por páginas',
      '.perfilmed [@usuario] - mostra perfil de mediador, horas na fila de controle e dados de PIX',
      '.rankmed - mostra ranking de mediadores por horas na fila de controle (owner apenas)',
      '.perfilss [@usuario] - mostra perfil de analista e total de análises',
      '.rankss - mostra ranking de analistas por análises (owner apenas)',
      '.perfiltld [@usuario] - mostra perfil de telador e total de telagens',
      '.ranktld - mostra ranking de teladores por telagens (owner apenas)',
      '.pix - abre o painel para cadastrar, verificar seu Pix ou consultar o Pix de um mediador (administração)',
      '.mediador - abre painel de mediadores com entrar/saír da fila de controle',
      '.meet - cria uma nova chamada pública no Google Meet (apenas mediador)',
      '.v - respondendo à mensagem do vencedor, registra vitória normal na aposta (mediador)',
      '.w - respondendo à mensagem do vencedor, registra vitória por W.O. sem coin (mediador)',
      '.blackl - abre painel de consulta de blacklist',
      '.rblack <id> - remove ID da blacklist',
      '.limparfilas - exclui as filas publicadas nos canais configurados',
      '.tmob - solicita telagem (apenas mediadores em canal 💸pagar-*)',
      '.ssmob - solicita SS (apenas mediadores em canal 💸pagar-*)',
      '.filas - abre formulário de publicação de fila (dono)',
      '.config - mostra configuração da fila do Free Fire (dono)',
      '.loja - abre painel de compra de cargos com coins',
      '.addcoins <@usuario|id> <quantidade> - adiciona coins ao usuário (mediador)',
      '.removercoins <@usuario|id> <quantidade> - remove coins do usuário (mediador)',
      '.addcargo <roleId> <preço> [nome] - adiciona cargo à loja (mediador)',
      '.remcargo <roleId> - remove cargo da loja (mediador)',
      '.listcargos - lista cargos disponíveis na loja (mediador)',
      '.embed <mensagem> - envia mensagem em embed (owner apenas)',
      '.me <mensagem> - envia mensagem normal como o bot (owner apenas)',
      '.ticket - abre ticket privado para o autor e o cargo AUXILIAR_ID',
      '.comandos - mostra a lista de comandos disponíveis'
    ];

    const comandosEmbed = new EmbedBuilder()
      .setTitle('📜 Comandos do Bot')
      .setDescription(commandsList.join('\n'))
      .setColor(0x3498db)
      .setTimestamp();

    await message.reply({ embeds: [comandosEmbed] });
    return;
  }

  if (command === 'limparfilas') {
    if (!message.guild || !ownerId || String(message.author.id) !== String(ownerId)) {
      await message.reply('Apenas o usuário configurado como proprietário do bot pode usar este comando.');
      return;
    }

    const botUserId = client.user?.id;
    if (!botUserId) {
      await message.reply('Não consegui identificar a conta do bot para localizar as filas.');
      return;
    }

    let guildChannels;
    try {
      guildChannels = await message.guild.channels.fetch();
    } catch (error) {
      console.error('Erro ao localizar canais para limpar filas:', error);
      await message.reply('Não consegui consultar os canais do servidor. Verifique as permissões do bot e tente novamente.');
      return;
    }

    const queueChannels = findQueueChannelConfigurations(
      [...guildChannels.values()].filter(channel => channel.type === ChannelType.GuildText)
    );
    if (queueChannels.length === 0) {
      await message.reply('Não encontrei canais de fila com tipo e modo no nome (ex.: `mobile-1v1`, `emulador-2v2`).');
      return;
    }

    let deletedCount = 0;
    let failedCount = 0;
    let scannedChannels = 0;

    for (const { channel } of queueChannels) {
      let before;
      let channelFetchFailed = false;
      scannedChannels += 1;

      while (true) {
        let batch;
        try {
          const options = { limit: 100 };
          if (before) options.before = before;
          batch = await channel.messages.fetch(options);
        } catch (error) {
          console.error(`Erro ao buscar mensagens para limpar filas em ${channel.id}:`, error);
          failedCount += 1;
          channelFetchFailed = true;
          break;
        }

        if (batch.size === 0) break;
        before = batch.last()?.id;

        for (const queueMessage of batch.values()) {
          if (!isQueueAnnouncementMessage(queueMessage, botUserId)) continue;
          try {
            await queueMessage.delete();
            deletedCount += 1;
          } catch (error) {
            console.error(`Erro ao excluir mensagem de fila ${queueMessage.id} em ${channel.id}:`, error);
            failedCount += 1;
          }
        }

        if (!before || batch.size < 100) break;
      }

      if (channelFetchFailed) continue;
    }

    const failedSummary = failedCount > 0
      ? ` Não foi possível processar ${failedCount} mensagem(ns/lote(s); veja o log do bot).`
      : '';
    try {
      await message.channel.send(
        `✅ Limpeza concluída: ${deletedCount} fila(s) excluída(s) em ${scannedChannels} canal(is) reconhecido(s).${failedSummary}`
      );
    } catch (error) {
      console.error('Erro ao enviar o resumo da limpeza de filas:', error);
    }
    return;
  }

  if (command === 'config') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply({
        embeds: [
          new EmbedBuilder()
.setTitle('<:alerta:> Acesso negado')
            .setDescription('Apenas o SOUZA pode usar este comando.')
            .setColor(0xff9900)
        ]
      });
      return;
    }

    const queueData = getGuildFFQueue(message.guild.id);
    const settings = queueData.queues?.Mobile?.settings || getQueueSettings(queueData);
    const configEmbed = new EmbedBuilder()
      .setTitle('⚙️ Configuração da fila')
      .setDescription('Edite os valores da aposta, envie todas as filas automaticamente ou escolha as opções de uma publicação.')
      .addFields(
        { name: 'Aposta padrão', value: `${settings.defaultEntryAmount} coins`, inline: true },
        { name: 'Mínimo para iniciar', value: `${settings.minPlayersToStart} jogadores`, inline: true },
        { name: 'Máximo da fila', value: `${settings.maxPlayersPerQueue} jogadores`, inline: true },
        { name: 'Valores das apostas', value: `${sortBetValuesDescending(settings.betValues).join(', ')}`, inline: false },
        { name: 'Thumbnail dos painéis auxiliares', value: `${settings.banner || 'Nenhuma configurada'}`, inline: false }
      )
      .setColor(0x3498db)
      .setFooter({ text: 'A edição é feita por modal, mantenha os valores formatados corretamente.' });
    const queueImage = getQueueImage(settings.banner);
    if (queueImage.url) configEmbed.setThumbnail(queueImage.url);

    const configButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('config-edit')
        .setLabel('Editar configuração')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('ff-queue-publish-auto')
        .setLabel('Enviar filas')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('ff-queue-publish')
        .setLabel('Publicar com opções')
        .setStyle(ButtonStyle.Secondary)
    );

    await message.reply({ embeds: [configEmbed], components: [configButtons] });
    return;
  }

  if (command === 'filas') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      let isOwner = false;
      try {
        const owner = await message.guild.fetchOwner();
        if (owner && String(owner.id) === String(message.author.id)) {
          isOwner = true;
        }
      } catch (err) {
        // ignore fetch errors
      }

      if (!isOwner) {
        await message.reply('Apenas o SOUZA pode usar este comando.');
        return;
      }
    }

    const publishButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ff-queue-publish')
        .setLabel('Publicar fila')
        .setStyle(ButtonStyle.Primary)
    );

    // tentamos apagar a mensagem de comando para limpar o canal
    await message.delete().catch(() => null);

    // Envia diretamente no canal (público)
    await message.channel.send({ content: 'Clique no botão abaixo para abrir o formulário de publicação de fila.', components: [publishButton] });
    return;
  }

  if (command === 'loja') {
    const queueData = getGuildFFQueue(message.guild.id);
    const queueBanner = Object.keys(ffQueueTypes)
      .map(queueType => queueData.queues?.[queueType]?.settings?.banner)
      .find(banner => getQueueImage(banner).url)
      || queueData.banner
      || '';
    const shopImage = getQueueImage(queueBanner);
    const shopImageAttachment = shopImage.url
      ? null
      : new AttachmentBuilder(path.join(__dirname, '..', 'assets', 'jordan-apostas.gif'), {
        name: 'jordan-apostas.gif'
      });
    const validRoles = Object.entries(lojaRoles)
      .filter(([roleId, role]) => message.guild.roles.cache.has(roleId))
      .map(([roleId, role]) => ({
        label: `${role.name} (${role.price} coins)`.slice(0, 100),
        value: roleId,
        description: `Adquirir por ${role.price} coins`.slice(0, 100)
      }))
      .slice(0, 25);

    if (validRoles.length === 0) {
      await message.reply('Nenhum cargo disponível na loja no momento.');
      return;
    }

    const lojaMenu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('loja-select-role')
        .setPlaceholder('Selecione um produto para comprar')
        .addOptions(validRoles)
    );

    const lojaEmbed = new EmbedBuilder()
      .setTitle('Lojinha de Cargos')
      .setDescription('Use seus **coins** para desbloquear cargos exclusivos. Selecione um cargo no menu abaixo para comprar.')
      .setColor(0x3498db)
      .setTimestamp();

    lojaEmbed.setThumbnail(shopImage.url || 'attachment://jordan-apostas.gif');

    await message.reply({
      embeds: [lojaEmbed],
      components: [lojaMenu],
      files: shopImageAttachment ? [shopImageAttachment] : []
    });
    return;
  }

  if (command === 'addcoins') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply('Apenas o mediador pode usar este comando.');
      return;
    }

    const targetUser = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0].replace(/[^0-9]/g, '')).catch(() => null) : null);
    const amount = parseInt(args[1] || args[0]);

    if (!targetUser || isNaN(amount) || amount < 1) {
      await message.reply('Use `.addcoins <@usuario|id> <quantidade>`');
      return;
    }

    const targetRecord = getUserRecord(targetUser.id);
    targetRecord.coins += amount;
    saveUserData(userData);

    await message.reply(`✅ Adicionei **${amount}** coins para ${targetUser}. O usuário agora tem **${targetRecord.coins}** coins.`);
    return;
  }

  if (command === 'removercoins') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply('Apenas o mediador pode usar este comando.');
      return;
    }

    const targetUser = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0].replace(/[^0-9]/g, '')).catch(() => null) : null);
    const amount = parseInt(args[1] || args[0]);

    if (!targetUser || isNaN(amount) || amount < 1) {
      await message.reply('Use `.removercoins <@usuario|id> <quantidade>`');
      return;
    }

    const targetRecord = getUserRecord(targetUser.id);
    targetRecord.coins = Math.max(0, targetRecord.coins - amount);
    saveUserData(userData);

    await message.reply(`✅ Removi **${amount}** coins de ${targetUser}. O usuário agora tem **${targetRecord.coins}** coins.`);
    return;
  }

  if (command === 'addcargo') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply('Apenas o mediador pode usar este comando.');
      return;
    }

    const roleId = args[0];
    const price = parseInt(args[1]);
    const roleName = args.slice(2).join(' ') || 'Cargo';

    if (!roleId || isNaN(price) || price < 1) {
      await message.reply('Use `.addcargo <roleId> <preço> [nome]`\nExemplo: `.addcargo 1234567890 50 Admin`');
      return;
    }

    if (!message.guild.roles.cache.has(roleId)) {
      await message.reply('Cargo não encontrado no servidor.');
      return;
    }

    lojaRoles[roleId] = {
      roleId,
      name: roleName,
      price
    };

    saveLojaRoles();
    await message.reply(`✅ Cargo **${roleName}** adicionado à loja por **${price}** coins.`);
    return;
  }

  if (command === 'remcargo') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply('Apenas o mediador pode usar este comando.');
      return;
    }

    const roleId = args[0];
    if (!roleId) {
      await message.reply('Use `.remcargo <roleId>`');
      return;
    }

    if (!lojaRoles[roleId]) {
      await message.reply('Este cargo não está na loja.');
      return;
    }

    const cargoName = lojaRoles[roleId].name;
    delete lojaRoles[roleId];
    saveLojaRoles();

    await message.reply(`✅ Cargo **${cargoName}** removido da loja.`);
    return;
  }

  if (command === 'listcargos') {
    if (!isOwnerAccess(message.guild, message.author.id)) {
      await message.reply('Apenas o mediador pode usar este comando.');
      return;
    }

    if (Object.keys(lojaRoles).length === 0) {
      await message.reply('Nenhum cargo disponível na loja no momento.');
      return;
    }

    const cargosList = Object.entries(lojaRoles)
      .map(([roleId, role]) => `**${role.name}** (\`${roleId}\`) - ${role.price} coins`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('📋 Cargos da Loja')
      .setDescription(cargosList)
      .setColor(0x3498db)
      .setTimestamp();

    await message.reply({ embeds: [embed] });
    return;
  }

  if (!ownerId) return;
  if (!isOwnerAccess(message.guild, message.author.id)) return;

  if (command === 'embed') {
    if (!text) {
      await message.reply('Use `.embed <mensagem>` para enviar a mensagem em embed.');
      return;
    }

    const embed = new EmbedBuilder()
      .setDescription(text)
      .setColor(0x3498db)
      .setTimestamp();

    await message.delete().catch(() => null);
    await message.channel.send({ embeds: [embed] });
    return;
  }

  if (command === 'me') {
    if (!text) {
      await message.reply('Use `.me <mensagem>` para enviar a mensagem normalmente.');
      return;
    }

    await message.delete().catch(() => null);
    await message.channel.send(text);
    return;
  }
});

if (!primaryGuildId || !/^\d{17,20}$/.test(primaryGuildId)) {
  console.error('GUILD_ID deve conter um ID numérico válido do servidor principal.');
  process.exitCode = 1;
} else {
  client.login(process.env.BOT_TOKEN);
}
