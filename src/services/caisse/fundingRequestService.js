const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const {
	generateFundingRequestForm,
	generateRequestDetailBlocks,
	generateFundingRequestBlocks,
} = require("./blockBuilders");
const { syncCaisseToExcel } = require("./excelSyncService");
const {
	notifyAdminRefund,
	notifyUserRefund,
} = require("./notificationService");
const { checkFormErrors, parseRefundFromText } = require("../aiService");
const { showCaisseOptions } = require("../Notifications/Caisse");
const { handleBalanceCheck } = require("../Payment/paymentReportService");
const { notifyUserAI } = require("../Order/orderNotificationService");
const Caisse = require("../../database/dbModels/Caisse");

// Import environment variables
require("dotenv").config();
async function handleFundingRequestSubmission(payload, context, userName) {
	console.log("** handleFundingRequestSubmission");
	const formData = payload.view.state.values;
	const userId = payload.channel?.id || payload.user.id;

	const errors = await checkFormErrors(formData, [], context);
	if (errors.errors.length) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: `Erreurs: ${errors.errors.join(", ")}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	// Parse amount and currency from input (e.g., "1000 USD")
	const amountInput = formData.funding_amount.input_funding_amount.value;
	const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/i);
	console.log("amountMatch", amountMatch);
	console.log("amountInput", amountInput);

	if (!amountMatch) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "Format du montant incorrect. Exemple: 1000 XOF",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	const amount = parseFloat(amountMatch[1]);
	const currency = amountMatch[2].toUpperCase();
	if (!["XOF", "USD", "EUR"].includes(currency.toUpperCase())) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "Devise non reconnue. Utilisez XOF, USD ou EUR.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	const reason = formData.funding_reason.input_funding_reason.value;
	const requestedDate = formData.funding_date.input_funding_date.selected_date;

	const caisse =
		(await Caisse.findOne()) ||
		new Caisse({
			balances: { XOF: 0, USD: 0, EUR: 0 },
			currency: "XOF",
		});

	// Generate requestId in format FUND/YYYY/MM/XXXX
	const now = new Date();
	const year = now.getFullYear();
	const month = (now.getMonth() + 1).toString().padStart(2, "0");
	const existingRequests = caisse.fundingRequests.filter((req) =>
		req.requestId.startsWith(`FUND/${year}/${month}/`)
	);
	const sequence = existingRequests.length + 1;
	const sequenceStr = sequence.toString().padStart(4, "0");
	const requestId = `FUND/${year}/${month}/${sequenceStr}`;

	// Push new funding request with "En attente" status
	caisse.fundingRequests.push({
		requestId,
		amount,
		currency,
		reason,
		requestedDate,
		submittedBy: userName,
		submittedByID: payload.user.id,

		submitterName: userName,
		status: "En attente",
		submittedAt: new Date(),
		workflow: {
			stage: "initial_request", // Track workflow stage
			history: [
				{
					stage: "initial_request",
					timestamp: new Date(),
					actor: userName,
					details: "Demande initiale soumise",
				},
			],
		},
	});

	await caisse.save();

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.user.id,
				user: payload.user.id,
				text: "Erreur lors de la synchronisation avec Excel. La demande a été enregistrée, mais contactez l'administrateur.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	if (!request) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{ channel: userId, user: userId, text: "Demande introuvable." },
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}
	// Generate funding request blocks
	const fundingRequestBlocks = generateFundingRequestBlocks({
		requestId,
		amount,
		currency,
		reason,
		requestedDate,

		userName,
		submittedAt: new Date(),
	});
	// Notify admin with initial approval buttons
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Demande de Fonds: ${requestId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				// ...fundingRequestBlocks,
				...generateRequestDetailBlocks(request),
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Pré-approuver", emoji: true },
							style: "primary",
							value: requestId,
							action_id: "pre_approve_funding", // New action for initial approval
						},
						{
							type: "button",
							text: { type: "plain_text", text: "Rejeter", emoji: true },
							style: "danger",
							value: requestId,
							action_id: "reject_fund",
						},
					],
				},
			],
			text: `Nouvelle demande de fonds: ${amount} ${currency} pour "${reason}" (ID: ${requestId})`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify the requester
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: payload.user.id,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: ":heavy_dollar_sign: Demande de Fonds",
						emoji: true,
					},
				},
				...fundingRequestBlocks,
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*\n ✅ Votre demande de fonds a été soumise. Vous serez notifié lorsqu'elle sera traitée.`,
						},
					],
				},
			],
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}
// Create and save refund request function
async function createAndSaveRefundRequest(
	userId,
	userName,
	channelName,
	parsedRequest,
	context
) {
	console.log("** createAndSaveRefundRequest");

	// Get or create caisse
	const caisse =
		(await Caisse.findOne()) ||
		new Caisse({
			balances: { XOF: 0, USD: 0, EUR: 0 },
			currency: "XOF",
		});

	// Generate requestId in format FUND/YYYY/MM/XXXX
	const now = new Date();
	const year = now.getFullYear();
	const month = (now.getMonth() + 1).toString().padStart(2, "0");
	const existingRequests = caisse.fundingRequests.filter((req) =>
		req.requestId.startsWith(`FUND/${year}/${month}/`)
	);
	const sequence = existingRequests.length + 1;
	const sequenceStr = sequence.toString().padStart(4, "0");
	const requestId = `FUND/${year}/${month}/${sequenceStr}`;

	// Handle date
	let requestedDate;
	if (parsedRequest.date_requise) {
		requestedDate = parsedRequest.date_requise;
	} else {
		requestedDate = new Date().toISOString().split("T")[0];
	}

	// Create refund request object
	const refundRequestData = {
		requestId,
		amount: parsedRequest.montant,
		currency: parsedRequest.devise.toUpperCase(),
		reason: parsedRequest.motif,
		requestedDate,
		submittedBy: userName,
		submittedByID: userId,
		submitterName: userName,
		status: "En attente",
		submittedAt: new Date(),
		workflow: {
			stage: "initial_request",
			history: [
				{
					stage: "initial_request",
					timestamp: new Date(),
					actor: userName,
					details: "Demande initiale soumise via commande",
				},
			],
		},
	};

	// Add to caisse
	caisse.fundingRequests.push(refundRequestData);
	await caisse.save();

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		context.log(`Excel sync failed for request ${requestId}: ${error.message}`);
	}

	// Return the created request
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);
	return request;
}
async function handleCaisseCommand(
	requestData,
	userPermissions,
	logger,
	context
) {
	const { userId, text, channelId } = requestData;
	const { isAdmin, isFinance } = userPermissions;

	if (!isAdmin && !isFinance) {
		return createSlackResponse(200, {
			text: "🚫 Seuls les utilisateurs de la finance peuvent gérer les demandes de fonds.",
		});
	}

	// Handle balance check
	if (text.trim() === "balance") {
		return await handleBalanceCheck(channelId);
	}

	// Handle refund requests with "devise" keyword
	if (text.toLowerCase().includes("devise")) {
		return await handleRefundRequest(text, requestData, logger);
	}

	// Handle text-based refund requests with "montant" keyword
	if (text && text.trim() && text.toLowerCase().includes("montant")) {
		return await handleTextBasedRefundRequest(
			text,
			requestData,
			logger,
			context
		);
	}

	// Show default caisse options
	return await showCaisseOptions(userId, channelId);
}

async function handleTextBasedRefundRequest(
	text,
	requestData,
	logger,
	context
) {
	const { userId, userName, channelId, channelName } = requestData;

	setImmediate(async () => {
		try {
			const parsedRequest = await parseRefundFromText(text, context);
			context.log(`Parsed refund request: ${JSON.stringify(parsedRequest)}`);

			if (
				parsedRequest.montant &&
				parsedRequest.devise &&
				parsedRequest.motif
			) {
				context.log(`Channel name resolved: ${channelName}`);

				const newRefundRequest = await createAndSaveRefundRequest(
					userId,
					userName,
					channelName,
					parsedRequest,
					context
				);

				context.log(
					`Refund request created: ${JSON.stringify(newRefundRequest)}`
				);

				await Promise.all([
					notifyAdminRefund(newRefundRequest, context),
					notifyUserRefund(newRefundRequest, userId, context),
				]);

				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: userId,
						user: userId,
						text: `✅ Demande de remboursement ${newRefundRequest.requestId} créée avec succès !`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			} else {
				context.log("Invalid refund request - missing required fields.");
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: userId,
						user: userId,
						text: "❌ Erreur: Montant, devise ou motif manquant dans votre demande de remboursement.",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		} catch (error) {
			context.log(`Background refund request creation error: ${error.stack}`);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: channelId,
					user: userId,
					text: `❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return { status: 200, body: "" };
}
async function FundsForm(payload, context) {
	try {
		const triggerId = payload.trigger_id;
		const channelId = payload.channel?.id;
		if (!triggerId || !channelId) {
			throw new Error("Missing trigger_id or channel_id");
		}
		const mockParams = new Map();
		mockParams.set("channel_id", channelId);
		mockParams.set("trigger_id", triggerId);

		const view = await generateFundingRequestForm(
			context,
			triggerId,
			mockParams
		);

		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`views.open response: ${JSON.stringify(response.data)}`);
		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}
		return createSlackResponse(200, "");
	} catch (error) {
		context.log(
			`❌ Error opening funding form: ${error.message}\nStack: ${error.stack}`
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "❌ Erreur lors de l'ouverture du formulaire. Veuillez réessayer.",
		});
	}
}
async function handleRefundRequest(text, requestData, logger) {
	logger.log(`Received refund request text: "${text}"`);
	logger.log("Starting AI parsing for refund request...");

	// Process in background
	setImmediate(async () => {
		try {
			await processRefundRequest(text, requestData, logger);
		} catch (error) {
			logger.log(`Background refund request creation error: ${error.stack}`);
			await notifyUserAI(
				{ id: "N/A" },
				requestData.channelId,
				logger,
				`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
			);
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Demande de remboursement en cours de traitement... Vous serez notifié(e) bientôt !",
	});
}

async function processRefundRequest(text, requestData, logger) {
	const { userId, userName, channelId, channelName } = requestData;

	const parsedRequest = await parseRefundFromText(text, logger);
	logger.log(`Parsed refund request: ${JSON.stringify(parsedRequest)}`);

	if (parsedRequest.montant && parsedRequest.devise) {
		logger.log(`Channel name resolved: ${channelName}`);
		const requestedDate = new Date(parsedRequest.date_requise);
		const currentDate = new Date();

		if (requestedDate < currentDate) {
			logger.log("Invalid refund request - requested date is in the past.");
			await notifyUserAI(
				{ id: "N/A" },
				channelId,
				logger,
				"⚠️ *Erreur*: La date sélectionnée est dans le passé."
			);
			return;
		}

		const newRefundRequest = await createAndSaveRefundRequest(
			userId,
			userName,
			channelName,
			parsedRequest,
			logger
		);

		logger.log(`Refund request created: ${JSON.stringify(newRefundRequest)}`);

		await Promise.all([
			notifyAdminRefund(newRefundRequest, logger),
			notifyUserRefund(newRefundRequest, userId, logger),
		]);
	} else {
		logger.log("Invalid refund request - missing amount or currency.");
		await notifyUserAI(
			{ id: "N/A" },
			userId,
			logger,
			"Montant ou devise manquant dans votre demande de remboursement."
		);
	}
}
module.exports = {
	handleFundingRequestSubmission,
	FundsForm,
	handleRefundRequest,
	handleCaisseCommand,
	handleTextBasedRefundRequest,
	createAndSaveRefundRequest,
	processRefundRequest,
};
