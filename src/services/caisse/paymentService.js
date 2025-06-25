const Caisse = require("../../database/dbModels/Caisse");
// Import other utilities or helper functions
const { syncCaisseToExcel } = require("./excelSyncService");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { generateFundingDetailsBlocks } = require("./blockBuilders");
const {
	generateFundingApprovalPaymentModal,
} = require("../Payment/blockBuilder");
const setImmediate = require("timers").setImmediate; // Node.js built-in module

async function handleFinanceDetailsSubmission(payload) {
	console.log("** handleFinanceDetailsSubmission - START");

	const formData = payload.view.state.values;
	const userId = payload.user.id;
	const userName = payload.user.username || userId;

	// Log metadata to verify values
	const metadata = JSON.parse(payload.view.private_metadata);
	console.log("METADATA:", metadata);
	const requestId = metadata.requestId;
	const originalMessageTs = metadata.messageTs;
	const originalChannelId = metadata.channelId;
	// const channelId = process.env.SLACK_FINANCE_CHANNEL_ID;
	// const messageTs = metadata.messageTs;

	console.log(
		`MessageTs: ${originalMessageTs}, ChannelId: ${originalChannelId}`
	);

	// Find the funding request
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { payment_method: "Demande introuvable" },
		});
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { payment_method: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];

	// Extract form data
	const paymentMethod =
		formData.payment_method.input_payment_method.selected_option.value;
	const paymentNotes = formData.payment_notes?.input_payment_notes?.value || "";
	console.log("Payment Method:", paymentMethod);
	const disbursementType = paymentMethod === "cash" ? "Espèces" : "Chèque";

	// Build payment details object
	const paymentDetails = {
		method: paymentMethod,
		notes: paymentNotes,
		approvedBy: userId,
		approvedAt: new Date(),
		filledBy: userId,
		filledByName: userName,
		filledAt: new Date(),
	};

	// Add cheque details if method is cheque
	if (paymentMethod === "cheque") {
		if (
			!formData.cheque_number ||
			!formData.cheque_bank ||
			!formData.cheque_date ||
			!formData.cheque_order
		) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "❌ Veuillez remplir tous les champs requis pour le chèque (numéro, banque, date, ordre).",
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
		paymentDetails.cheque = {
			number: formData.cheque_number.input_cheque_number.value,
			bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
			date: formData.cheque_date.input_cheque_date.selected_date,
			order: formData.cheque_order.input_cheque_order.value,
			urls: urls,
			file_ids: fileIds,
		};
	}

	request.paymentDetails = paymentDetails;
	request.disbursementType = disbursementType;

	// Update workflow status
	request.status = "Détails fournis";
	request.workflow.stage = "details_submitted";
	request.workflow.history.push({
		stage: "details_submitted",
		timestamp: new Date(),
		actor: userId,
		details: "Détails financiers fournis",
	});

	await caisse.save();

	// Log the message update attempt
	console.log("Attempting to update message...");
	console.log(`Channel: ${originalChannelId}, TS: ${originalMessageTs}`);
	// Build cheque details text for display if applicable

	// Generate blocks for Slack message
	const block = generateFundingDetailsBlocks(
		request,
		paymentMethod,
		paymentNotes,
		paymentDetails,
		userId
	);

	// Update finance team message - IMPORTANT: Remove the button from the message
	if (originalMessageTs && originalChannelId) {
		try {
			const updatedMessage = {
				channel: originalChannelId,
				ts: originalMessageTs,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de Fonds: ${
								requestId || "N/A"
							}`,
							emoji: true,
						},
					},
					...block,

					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Signaler un problème",
									emoji: true,
								},
								style: "danger",
								action_id: "report_fund_problem",
								value: requestId || "N/A", // Ensure requestId is defined
							},
						],
					},
				],

				text: `Demande de fonds ${
					requestId || "N/A"
				} - Détails fournis, en attente d'approbation finale`,
			};

			console.log("Update message payload:", JSON.stringify(updatedMessage));

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/chat.update",
				updatedMessage,
				process.env.SLACK_BOT_TOKEN
			);

			console.log("Slack update response:", JSON.stringify(response));

			if (!response.ok) {
				console.error(`Failed to update message: ${response.error}`);
			}
		} catch (error) {
			console.error(`Error updating message: ${error.message}`);
		}
	} else {
		console.log("Missing messageTs or channelId - cannot update message");
	}

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
	}

	// Create rich notification for admin final approval
	console.log("Sending admin notification...");
	try {
		const adminResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de Fonds - Approbation Finale : ${requestId}`,
							emoji: true,
						},
					},

					...block,

					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Approuver", emoji: true },
								style: "primary",
								value: requestId,
								action_id: "funding_approval_payment",
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
				text: `Demande de fonds ${requestId} - Approbation finale requise`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Admin notification response:", JSON.stringify(adminResponse));
	} catch (error) {
		console.error(`Error sending admin notification: ${error.message}`);
	}

	console.log("** handleFinanceDetailsSubmission - END");
	return createSlackResponse(200, { response_action: "clear" });
}
async function handleFillFundingDetails(payload, action, context) {
	context.log("** Processing fill_funding_details");

	const messageTs = payload.message?.ts;
	const channelId = payload.channel?.id;

	context.log(`Message TS: ${messageTs}, Channel ID: ${channelId}`);

	// Immediate response
	const immediateResponse = createSlackResponse(200, {
		response_action: "clear",
	});

	// Process in background
	setImmediate(async () => {
		try {
			const requestId = action.value;
			await generateFundingApprovalPaymentModal(
				context,
				payload.trigger_id,
				messageTs,
				requestId,
				channelId
			);
		} catch (error) {
			context.log(
				`Error in fill_funding_details background processing: ${error.message}`
			);
		}
	});

	return immediateResponse;
}
async function handleFundingApprovalSubmission(payload, context, userName) {
	console.log("** handleFundingApprovalSubmission");
	const formData = payload.view.state.values;
	const userId = userName;
	const requestId =
		payload.view.private_metadata ||
		formData.request_id?.input_request_id?.value;
	const action =
		formData.approval_action.select_approval_action.selected_option.value;
	const chequeDetails = formData.cheque_details?.input_cheque_details?.value;

	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	if (!request) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{ channel: userId, user: userId, text: "Demande introuvable." },
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	if (action === "reject") {
		request.status = "Rejeté";
		request.approvedBy = userId;
		request.approvedAt = new Date();
	} else {
		request.status = "Validé";
		request.approvedBy = userId;
		request.approvedAt = new Date();
		request.disbursementType = action === "approve_cash" ? "Espèces" : "Chèque";

		if (chequeDetails) request.chequeDetails = chequeDetails;

		caisse.balance += request.amount;
		caisse.transactions.push({
			type: "Funding",
			amount: request.amount,
			currency: request.currency,
			requestId,
			details: `Approuvée par ${userId} (${request.disbursementType})`,
		});
	}

	await caisse.save();
	await syncCaisseToExcel(caisse);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			text: `Demande ${requestId} ${request.status}: ${request.amount} ${
				request.currency
			} (${request.disbursementType || "Rejeté"})`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}
// Function to handle the approval submission
async function handleFundingApprovalPaymentSubmission(
	payload,
	context,
	userName,
	messageTs
) {
	console.log("** handleFundingApprovalPaymentSubmission");
	const formData = payload.view.state.values;
	const privateMetadata = JSON.parse(payload.view.private_metadata);
	console.log("privateMetadata", privateMetadata);
	const requestId = privateMetadata.requestId;
	const userId = userName || payload.user.id;
	const originalMessageTs = privateMetadata.messageTs; // Original message timestamp
	const channelId = privateMetadata.channelId || process.env.SLACK_ADMIN_ID; // Channel ID
	const amount = privateMetadata.amount; // Use metadata
	const currency = privateMetadata.currency; // Use metadata
	const reason = privateMetadata.reason; // Use metadata
	const requestedDate = privateMetadata.requestedDate; // Use metadata
	const submitterName = privateMetadata.submitterName; // Use metadata

	// Get payment method
	const paymentMethod =
		formData.payment_method.input_payment_method.selected_option.value;
	const paymentNotes = formData.payment_notes?.input_payment_notes?.value || "";
	const disbursementType = paymentMethod === "cash" ? "Espèces" : "Chèque";

	// Build payment details object
	const paymentDetails = {
		method: paymentMethod,
		notes: paymentNotes,
		approvedBy: userId,
		approvedAt: new Date(),
	};

	// Add cheque details if method is cheque
	if (paymentMethod === "cheque") {
		if (
			!formData.cheque_number ||
			!formData.cheque_bank ||
			!formData.cheque_date ||
			!formData.cheque_order
		) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: "❌ Veuillez remplir tous les champs requis pour le chèque (numéro, banque, date, ordre).",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}

		paymentDetails.cheque = {
			number: formData.cheque_number.input_cheque_number.value,
			bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
			date: formData.cheque_date.input_cheque_date.selected_date,
			order: formData.cheque_order.input_cheque_order.value,
		};
	}

	try {
		// Process the funding approval with payment details
		await processFundingApprovalWithPayment(
			requestId,
			disbursementType,
			userId,
			paymentDetails
		);

		// Delete the processing message
		if (messageTs) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.delete",
				{
					channel: channelId,
					ts: messageTs,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		// Update the original message in the admin channel
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: channelId,
				ts: originalMessageTs, // Use the original message timestamp
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: ":heavy_dollar_sign: Demande de Fonds ",
							emoji: true,
						},
					},
					{
						type: "divider",
					},
					{
						type: "section",
						fields: [
							{ type: "mrkdwn", text: `*ID:*\n${requestId}` },
							{ type: "mrkdwn", text: `*Montant:*\n${amount} ${currency}` },
							{ type: "mrkdwn", text: `*Motif:*\n${reason}` },
							{ type: "mrkdwn", text: `*Date requise:*\n${requestedDate}` },
							{
								type: "mrkdwn",
								text: `*Demandeur:*\n${submitterName || userId}`,
							},
							{
								type: "mrkdwn",
								text: `*Date d'approbation:*\n${new Date().toLocaleDateString()}`,
							},
						],
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `✅ Approuvé par <@${userId}> (Méthode: ${
								paymentMethod === "cash" ? "Espèces" : "Chèque"
							})`,
						},
					},
				],
				text: `Demande ${requestId} approuvée par ${userId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Send confirmation message to the user
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: userId,
				text: `✅ Demande ${requestId} approuvée avec succès (Méthode: ${
					paymentMethod === "cash" ? "Espèces" : "Chèque"
				})`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	} catch (error) {
		console.error("Error processing funding approval:", error);
		// Delete the processing message if there's an error
		if (messageTs) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.delete",
				{
					channel: channelId,
					ts: messageTs,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: `❌ Erreur lors de l'approbation: ${error.message}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	}
}
async function processFundingApprovalWithPayment(
	requestId,
	paymentMethod,
	userId,
	paymentDetails
) {
	console.log("** processFundingApprovalWithPayment");
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});

	if (!caisse) throw new Error("Caisse non trouvée");

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);

	if (requestIndex === -1) throw new Error("Demande non trouvée");

	const request = caisse.fundingRequests[requestIndex];

	// Update request status and details
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date();
	request.disbursementType = paymentMethod === "cash" ? "Espèces" : "Chèque";
	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Demande approuvée avec détails de paiement",
	});
	// Store payment details
	request.paymentDetails = paymentDetails;

	// Update balance for the specific currency
	caisse.balances[request.currency] =
		(caisse.balances[request.currency] || 0) + request.amount;

	// Add transaction record
	let transactionDetails = `Approuvé par ${userId} (${request.disbursementType})`;

	if (paymentMethod === "cheque" && paymentDetails.cheque) {
		transactionDetails += ` - Chèque #${paymentDetails.cheque.number} de ${paymentDetails.cheque.bank}`;
	}

	caisse.transactions.push({
		type: "Funding",
		amount: request.amount,
		currency: request.currency,
		requestId,
		details: transactionDetails,
		timestamp: new Date(),
		paymentMethod: request.disbursementType,
		paymentDetails: request.paymentDetails,
	});

	// Save changes to database
	await caisse.save();

	// Sync to Excel to update the existing row
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		// Continue despite Excel sync failure
	}

	// Notify the requester
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: "✅ Demande de Fonds Approuvée",
						emoji: true,
					},
				},
				{
					type: "section",
					fields: [
						{ type: "mrkdwn", text: `*ID:*\n${requestId}` },
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
						{ type: "mrkdwn", text: `*Méthode:*\n${request.disbursementType}` },
					],
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Approuvé par <@${userId}> le ${new Date().toLocaleDateString(
								"fr-FR"
							)}`,
						},
					],
				},
			],
			text: `Votre demande de fonds ${requestId} a été approuvée (${request.amount} ${request.currency})`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return true;
}
// Helper function to update request status
async function updateRequestStatus(request, userId) {
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date();
	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Demande approuvée avec détails de paiement",
	});
}

// Helper function to update caisse balance
async function updateCaisseBalance(caisse, request, requestId, userId) {
	caisse.balances[request.currency] =
		(caisse.balances[request.currency] || 0) + request.amount;

	caisse.transactions.push({
		type: "Funding",
		amount: request.amount,
		currency: request.currency,
		requestId,
		details: `Approuvé par ${userId} (${request.disbursementType})`,
		timestamp: new Date(),
		paymentMethod: request.disbursementType,
		paymentDetails: request.paymentDetails,
	});

	await caisse.save();
}
module.exports = {
	handleFinanceDetailsSubmission,
	handleFillFundingDetails,
	handleFundingApprovalSubmission,
	handleFundingApprovalPaymentSubmission,
	processFundingApprovalWithPayment,
	updateRequestStatus,
	updateCaisseBalance,
};
