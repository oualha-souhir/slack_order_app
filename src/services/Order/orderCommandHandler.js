const {
	createSlackResponse,
	postSlackMessageWithRetry,
} = require("../../Handlers/slackApiUtils.js");
const {
	parseOrderFromText,
	getOrderSummary,
	handleAICommand,
	handleAskAI,
} = require("../aiService");
const { exportReport } = require("../Reports/Orders");
const Order = require("../../database/dbModels/Order");
const { analyzeTrends, generateReport } = require("../Reports/reportService");

const {
	handleAddRole,
	handleRemoveRole,
	handleListUsers,
	handleHelp,
} = require("../UserManagement.js");
const { handleDeleteOrder } = require("./orderFormHandler");
const {
	notifyAdmin,
	notifyUser,
	notifyUserAI,
} = require("./orderNotificationService");
const {
	createAndSaveOrder,
	handleOrderList,
	handleOrderListSlack,
	handleOrderOverview,
} = require("./orderService");
const {  parseFilters } = require("./orderHelpers");
const {
	handleConfig,
	handleAddConfig,
	handleRemoveConfig,
} = require("../configService");
const { handleCheckDelays } = require("../handledelay");

async function handleOrderCommand(
	requestData,
	userPermissions,
	logger,
	context,
	openai
) {
	console.log("** handleOrderCommand");
	const { text, userId } = requestData;
	const { isAdmin } = userPermissions;

	// Handle empty text - show welcome message
	if (!text.trim()) {
		return await showOrderWelcome(userId);
	}

	// Parse text arguments
	const textArgs = text.trim().split(" ");
	const subCommand = textArgs[0];

	// Route to specific order sub-commands
	const orderCommandHandlers = {
		report: () => handleOrderReport(text, requestData, isAdmin, context),
		summary: () => handleOrderSummary(context),
		"add-role": () => handleAddRole(text, requestData, isAdmin),
		"rm-role": () => handleRemoveRole(text, requestData, isAdmin),
		"list-users": () => handleListUsers(isAdmin),
		config: () => handleConfig(isAdmin),
		add: () => handleAddConfig(textArgs, isAdmin),
		rm: () => handleRemoveConfig(textArgs, isAdmin),
		help: () => handleHelp(userPermissions),
		my: () =>
			text.includes("order")
				? handleMyOrder(userId, requestData.channelId)
				: null,
		resume: () => handleResumeCommand(logger, openai),
		list: () => handleListCommand(textArgs, isAdmin, context),
		filterby: () => handleFilterCommand(textArgs, isAdmin, context),
		"check-delays": () => handleCheckDelays(),
		delete: () => handleDeleteOrder(text, requestData, isAdmin, context),
		ask: () =>
			text.includes("ai:") ? handleAskAI(text, requestData, context) : null,
	};

	// Execute sub-command handler
	if (orderCommandHandlers[subCommand]) {
		const result = await orderCommandHandlers[subCommand]();
		if (result) return result;
	}

	// Handle text-based order creation
	if (text.toLowerCase().includes("equipe")) {
		return await handleOrderTextParsing(text, requestData, logger, context);
	}

	// Default fallback for unhandled commands
	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "❓ Commande non reconnue. Utilisez `/order help` pour voir les options disponibles.",
	});
}
async function showOrderWelcome(userId) {
	console.log("** showOrderWelcome");
	return createSlackResponse(200, {
		response_type: "ephemeral",
		blocks: [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: "👋 Bienvenue",
					emoji: true,
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `Bonjour <@${userId}> ! Voici comment passer une nouvelle commande:`,
				},
			},
			{
				type: "divider",
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Option 1:* Créez une commande rapide avec la syntaxe suivante:",
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "```\n/order titre: [Votre titre] equipe: [Nom de l'équipe] date requise: yy-mm-jj articles: [quantité] [unité] Désignation: [désignation]\n```",
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "💡 *Exemple:* `/order titre: Matériel Électrique equipe: Maçons date requise: 2025-12-12 articles: 10 piece Désignation: rouleaux de câble souple VGV de 2×2,5 bleu-marron`",
					},
				],
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Option 2:* Utilisez la formulaires ci-dessous",
				},
			},
		],
		text: `👋 Bonjour <@${userId}> ! Pour passer une demande, vous pouvez utiliser les formulaires ou les commandes directes.`,
		attachments: [
			{
				callback_id: "order_form",
				actions: [
					{
						name: "open_form",
						type: "button",
						text: "📋 Nouvelle commande",
						value: "open",
						action_id: "open_form",
						style: "primary",
					},
				],
			},
		],
	});
}
async function handleOrderTextParsing(text, requestData, logger, context) {
	const { userId, userName, channelId, channelName } = requestData;

	context.log(`Received text: "${text}"`);
	context.log("Starting AI parsing...");

	setImmediate(async () => {
		try {
			const parsedOrder = await parseOrderFromText(text, logger);
			logger.log(`Parsed order: ${JSON.stringify(parsedOrder)}`);

			if (parsedOrder.articles && parsedOrder.articles.length > 0) {
				logger.log(`Channel name resolved: ${channelId}`);
				const requestedDate = new Date(parsedOrder.date_requise);
				const currentDate = new Date();
				console.log(
					`Requested date: ${requestedDate}, Current date: ${currentDate}`
				);
				const normalizeDate = (date) =>
					new Date(date.toISOString().split("T")[0]);

				const normalizedRequestedDate = normalizeDate(requestedDate);
				const normalizedCurrentDate = normalizeDate(currentDate);

				if (normalizedRequestedDate < normalizedCurrentDate) {
					logger.log("Invalid order request - requested date is in the past.");
					await notifyUserAI(
						{ id: "N/A" },
						channelId,
						logger,
						"⚠️ *Erreur*: La date sélectionnée est dans le passé."
					);
					return;
				}

				// const normalizedEquipe = normalizeTeamName(parsedOrder.equipe);
				// console.log(`Normalized team name: ${normalizedEquipe}`);
				const newOrder = await createAndSaveOrder(
					userId,
					userName,
					channelName,
					channelId,
					{
						request_title: {
							input_request_title: {
								value: parsedOrder.titre || "Commande sans titre",
							},
						},
						equipe_selection: {
							select_equipe: {
								selected_option: {
									text: {
										text: parsedOrder.equipe, // Ensure `normalizedEquipe` is assigned to the nested `text` property
									},
								},
							},
						},
						request_date: {
							input_request_date: {
								selected_date:
									parsedOrder.date_requise ||
									new Date().toISOString().split("T")[0],
							},
						},
					},
					parsedOrder.articles.map((article) => ({
						quantity: article.quantity || 1,
						unit: article.unit || undefined,
						designation: article.designation || "Article non spécifié",
					})),
					[],
					[],
					logger
				);

				logger.log(`Order created: ${JSON.stringify(newOrder)}`);
				await Promise.all([
					notifyAdmin(newOrder, logger),
					notifyUser(newOrder, userId, logger),
				]);
			} else {
				logger.log("No articles found in parsed order.");
				await notifyUserAI(
					{ id_commande: "N/A" },
					channelId,
					logger,
					"Aucun article détecté dans votre commande."
				);
			}
		} catch (error) {
			logger.log(`Background order creation error: ${error.stack}`);
			await notifyUserAI(
				{ id_commande: "N/A" },
				channelId,
				logger,
				`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
			);
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
	});
}

async function handleOrderReport(text, requestData, isAdmin, context) {
	const { userId, channelId } = requestData;

	if (!isAdmin) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "🚫 Seuls les administrateurs peuvent générer des rapports.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return { status: 200, body: "" };
	}

	setImmediate(async () => {
		const args = text.trim().split(" ").slice(1);
		if (args.length < 2) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: "❌ Usage: /order report [order|team|date] [value]\nExemple: /order report order CMD/2025/03/0001 ou /order report team Maçons ou /order report date 2025-03-01",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { status: 200, body: "" };
		}

		const [reportType, ...valueParts] = args;
		const value = valueParts.join(" ");

		try {
			await exportReport(context, reportType, value, userId, channelId);
			return { status: 200, body: "" };
		} catch (error) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: `❌ Erreur lors de la génération du rapport : ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { status: 200, body: "" };
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Génération du rapport en cours... Vous recevrez le fichier Excel dans quelques instants.",
	});
}
async function handleMyOrder(userId, channelId) {
	const summary = await getOrderSummary(userId);

	if (summary) {
		const response = `📋 **Résumé de votre dernière commande**
ID: ${summary.id}
📝 Titre: ${summary.title}
👥 Équipe: ${summary.team}
📊 Statut: ${summary.status}
💰 Total: ${summary.totalAmount}€
✅ Payé: ${summary.amountPaid}€
⏳ Restant: ${summary.remainingAmount}€
📄 Proformas: ${summary.validatedProformasCount}/${summary.proformasCount}`;

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: channelId,
				text: response,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return { status: 200, body: "" };
	}

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "Aucune commande trouvée pour votre compte.",
	});
}

async function handleResumeCommand(logger, openai) {
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		process.env.SLACK_BOT_TOKEN
	);

	setImmediate(async () => {
		await handleAICommand(
			logger,
			openai,
			Order,
			notifyUserAI,
			createSlackResponse
		);
	});

	return createSlackResponse(200, "AI command processed successfully.");
}

async function handleListCommand(textArgs, isAdmin, context) {
	try {
		if (textArgs[1] === "detailed") {
			return await handleOrderList(isAdmin, context);
		}
		return await handleOrderListSlack(isAdmin, context);
	} catch (error) {
		console.error(`Background list processing error: ${error.stack}`);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "⌛ Liste en cours de génération... Vous recevrez un résumé bientôt !",
		});
	}
}

async function handleFilterCommand(textArgs, isAdmin, context) {
	try {
		const argsToParse = textArgs.slice(1);
		context.log(`🧩 Args to parse: ${JSON.stringify(argsToParse)}`);
		const filters = parseFilters(argsToParse);
		context.log(`🔍 Filters parsed: ${JSON.stringify(filters)}`);
		const response = await handleOrderOverview(isAdmin, filters, context);
		context.log(`📤 Response to Slack: ${JSON.stringify(response)}`);
		return response;
	} catch (error) {
		console.error(`Background filter processing error: ${error.stack}`);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "⌛ Filtrage en cours... Vous recevrez un résumé bientôt !",
		});
	}
}
async function handleOrderSummary(context) {
	await generateReport(context);
	await analyzeTrends(context);
	return createSlackResponse(200, "summary completed!");
}

module.exports = {
	handleOrderCommand,
};
