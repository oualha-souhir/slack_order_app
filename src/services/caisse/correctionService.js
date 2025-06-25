const Caisse = require("../../database/dbModels/Caisse");
const {
	createSlackResponse,
	postSlackMessageWithRetry,
} = require("../../Handlers/slackApiUtils");
const {
	generateCorrectionModal,
	generateFundingDetailsBlocks,
} = require("./blockBuilders");
const { syncCaisseToExcel } = require("./excelSyncService");
const { getPaymentMethodText } = require("../../Handlers/Utils");

// Import environment variables
require("dotenv").config();
async function handleCorrectionSubmission(payload, context) {
	console.log("** handleCorrectionSubmission");
	const metadata = JSON.parse(payload.view.private_metadata);
	const requestId = metadata.entityId;
	const channelId = metadata.channelId;
	const messageTs = metadata.messageTs;
	const userId = payload.user.username;

	const formData = payload.view.state.values;

	// Fetch caisse from database
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	// Find the specific funding request
	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];
	// Retrieve amount, currency, and paymentNotes from the database
	const amount = request.amount;
	const currency = request.currency?.toUpperCase();
	const paymentNotes = request.paymentDetails?.notes || "";

	// Validate amount and currency
	if (!amount || !currency) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: {
				general: "Montant ou devise manquant dans la base de données.",
			},
		});
	}

	if (amount <= 0) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Le montant doit être supérieur à zéro." },
		});
	}

	// Validate payment method from form
	let paymentMethod =
		formData.payment_method?.input_payment_method?.selected_option?.value;
	console.log("paymentMethod", paymentMethod);
	if (!paymentMethod) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { payment_method: "La méthode de paiement est requise." },
		});
	}
	const paymentMethod1 = getPaymentMethodText(paymentMethod);
	console.log("paymentMethod", paymentMethod1);

	// Update request details
	request.amount = amount; // Already set, but kept for clarity

	request.disbursementType = paymentMethod1; // Already set, but kept for clarity

	request.currency = currency; // Already set, but kept for clarity
	request.paymentDetails = {
		method: paymentMethod1,
		notes: paymentNotes, // Use database value
		approvedBy: userId,
		approvedAt: new Date(),
		filledBy: userId,
		filledAt: new Date(),
	};
	console.log("paymentMethod2", paymentMethod);
	if (paymentMethod !== "cheque") {
		delete request.paymentDetails.cheque; // Remove cheque details if method changes
	}
	if (paymentMethod === "cheque") {
		console.log("111");
		if (
			!formData.cheque_number?.input_cheque_number?.value ||
			!formData.cheque_bank?.input_cheque_bank?.selected_option?.value ||
			!formData.cheque_date?.input_cheque_date?.selected_date ||
			!formData.cheque_order?.input_cheque_order?.value
		) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "⚠️ Veuillez remplir tous les champs requis pour le chèque.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}
		// Extract file IDs from file_input
		const fileIds =
			formData.cheque_files?.input_cheque_files?.files?.map(
				(file) => file.url_private
			) || [];
		console.log("File IDs:", fileIds);
		// Process URLs (comma-separated string to array)
		const urlsString = formData.cheque_urls?.input_cheque_urls?.value || "";
		const urls = urlsString
			? urlsString
					.split(",")
					.map((url) => url.trim())
					.filter((url) => /^https?:\/\/[^\s,]+$/.test(url))
			: [];
		console.log("URLs:", urls);
		request.paymentDetails.cheque = {
			number: formData.cheque_number.input_cheque_number.value,
			bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
			date: formData.cheque_date.input_cheque_date.selected_date,
			order: formData.cheque_order.input_cheque_order.value,
			urls: urls.length > 0 ? urls : [],
			file_ids: fileIds.length > 0 ? fileIds : [],
		};
	}

	if (paymentMethod !== "cheque") {
		console.log("222");
		request.paymentDetails.cheque = null;
	}
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date(); // Approved At

	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Détails corrigés et approuvés",
	});
	// Consolidate database update
	const update = {
		$set: { [`fundingRequests.${requestIndex}`]: request },
		$push: {
			transactions: {
				type: "Funding",
				amount: amount,
				currency: currency,
				requestId,
				details: `Corrigé et approuvé par <@${userId}> `,
				timestamp: new Date(),
			},
		},
	};
	console.log("request.changed", request.changed);
	// Increment balance only if not previously updated
	if (request.changed == false) {
		update.$inc = { [`balances.${currency}`]: amount };
		console.log(
			`[Balance Update] Incrementing balances.${currency} by ${amount}`
		);
	}
	request.changed = true; // Already set, but kept for clarity

	// Perform atomic update and fetch updated document
	const updatedCaisse = await Caisse.findOneAndUpdate(
		{ "fundingRequests.requestId": requestId },
		update,
		{ new: true }
	);

	// Log the updated balance
	console.log(
		`[Balance Update] Updated caisse balances:`,
		JSON.stringify(updatedCaisse.balances, null, 2)
	);

	// Sync to Excel
	try {
		await syncCaisseToExcel(updatedCaisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Erreur lors de la synchronisation Excel pour ${requestId}. Contactez l'administrateur.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}

	// Notify finance team
	const chequeDetailsText =
		paymentMethod === "cheque"
			? `\n• Numéro: ${request.paymentDetails.cheque.number}\n• Banque: ${request.paymentDetails.cheque.bank}\n• Date: ${request.paymentDetails.cheque.date}\n• Ordre: ${request.paymentDetails.cheque.order}`
			: "";
	const block = generateFundingDetailsBlocks(
		request,
		request.paymentDetails.method,
		request.paymentDetails.notes,
		request.paymentDetails,
		userId
	);
	console.log("request.paymentDetails.method", request.paymentDetails.method);
	console.log("request", request);
	console.log("request.paymentDetails", request.paymentDetails);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: ✅ Demande de Fonds - Corrigée et Approuvée : ${requestId}`,
						emoji: true,
					},
				},
				...block,
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
			],
			text: `Demande ${requestId} corrigée et approuvée`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: ✅ Demande de Fonds - Corrigée et Approuvée : ${requestId}`,
						emoji: true,
					},
				},
				...block,
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
			],
			text: `Demande ${requestId} corrigée et approuvée`,
		},
		process.env.SLACK_BOT_TOKEN
	);
	return createSlackResponse(200, { response_action: "clear" });
}
async function handleCorrectFundingDetails(payload, action, context) {
	context.log("** Processing correct_funding_details");

	try {
		const value = JSON.parse(action.value);
		const { requestId, channelId, messageTs } = value;

		await generateCorrectionModal(
			context,
			payload.trigger_id,
			requestId,
			channelId,
			messageTs
		);

		return createSlackResponse(200, "");
	} catch (error) {
		context.log(`Error parsing correction details: ${error.message}`);
		throw error;
	}
}
// Handle problem report submission
async function handleProblemSubmission(payload, context) {
	console.log("** handleProblemSubmission");
	const metadata = JSON.parse(payload.view.private_metadata);
	const requestId = metadata.entityId;
	const channelId = process.env.SLACK_FINANCE_CHANNEL_ID;
	const messageTs = metadata.messageTs;
	console.log("messageTs1", messageTs);
	const userId = payload.user.id;

	const formData = payload.view.state.values;
	let problemType =
		formData.problem_type.select_problem_type.selected_option.value;
	const problemDescription =
		formData.problem_description.input_problem_description.value;
	console.log("problemType", problemType);
	problemType = getProblemTypeText(problemType);
	console.log("problemType", problemType);

	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];

	// Check if the request is already approved
	if (request.status === "Validé") {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "Impossible de signaler un problème : la demande a déjà été approuvée.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	// Store the problem report
	request.issues = request.issues || [];
	request.issues.push({
		type: problemType,
		description: problemDescription,
		reportedBy: userId,
		reportedAt: new Date(),
	});

	request.workflow.history.push({
		stage: "problem_reported",
		timestamp: new Date(),
		actor: userId,
		details: `Problème signalé: ${problemType} - ${problemDescription}`,
	});

	await caisse.save();
	console.log("request1", request);
	console.log("request.paymentDetails1", request.paymentDetails);
	let chequeDetailsText = "";
	console.log("request1", request);
	if (
		request.paymentDetails.method === "cheque" &&
		request.paymentDetails.cheque
	) {
		// Send notification to admin
		chequeDetailsText = request.paymentDetails?.cheque
			? `\n• Numéro: ${request.paymentDetails.cheque.number}\n• Banque: ${request.paymentDetails.cheque.bank}\n• Date: ${request.paymentDetails.cheque.date}\n• Ordre: ${request.paymentDetails.cheque.order}`
			: "";
	}
	const block = generateFundingDetailsBlocks(
		request,
		request.paymentDetails.method,
		request.paymentDetails.notes,
		request.paymentDetails,
		userId
	);
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			text: `✅ Problème signalé sur la demande de fonds ${requestId}`,
		},
		process.env.SLACK_BOT_TOKEN
	);
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Problème Signalé sur Demande de Fonds: ${requestId}`,
						emoji: true,
					},
				},
				...block,
				// {
				//   type: "section",
				//   fields: [
				//     { type: "mrkdwn", text: `*ID:*\n${requestId}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Montant:*\n${request.amount} ${request.currency}`,
				//     },
				//     { type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Demandeur:*\n${
				//         request.submitterName || request.submittedBy
				//       }`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Méthode:*\n${getPaymentMethodText(
				//         request.paymentDetails.method
				//       )}\n${chequeDetailsText}`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Notes:*\n${request.paymentDetails.notes || "Aucune"}`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Détails fournis par:*\n<@${request.paymentDetails.filledByName}>`,
				//     },
				//   ],
				// },
				{
					type: "divider",
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Problème*: ${problemType} `,
						},
						{
							type: "mrkdwn",
							text: `*Description*: ${problemDescription}`,
						},
						{
							type: "mrkdwn",
							text: `*Signalé par:* <@${userId}>`,
						},
					],
				},

				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: {
								type: "plain_text",
								text: "Corriger les détails",
								emoji: true,
							},
							style: "primary",
							value: JSON.stringify({ requestId, channelId, messageTs }),
							action_id: "correct_funding_details",
						},
					],
				},
			],
			text: `Problème signalé sur demande ${requestId}`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, { response_action: "clear" });
}
module.exports = {
	handleCorrectionSubmission,
	handleCorrectFundingDetails,
	handleProblemSubmission,
};
