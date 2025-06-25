// generateRequestDetailBlocks
// const { syncCaisseToExcel } = require("@/utils/excelSyncUtils");
// const { getPaymentMethodText } = require("@/utils/paymentUtils");
// // Import Node.js built-in modules if needed
// const { setImmediate } = require("timers");

const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const {
	generateRequestDetailBlocks,
	generateFundingRequestBlocks,
} = require("./blockBuilders");
const { syncCaisseToExcel } = require("./excelSyncService");
const { setImmediate } = require("timers");
const Caisse = require("../../database/dbModels/Caisse");
const {
	updateRequestStatus,
	updateCaisseBalance,
} = require("./paymentService");
const {
	getPaymentMethodText,
	createImmediateResponse,
} = require("../../Handlers/Utils");
const {
	generateFundingApprovalPaymentModal,
} = require("../Payment/blockBuilder");

async function handlePreApproval(payload) {
	console.log("** handlePreApproval");
	// Parse the private metadata to get request info
	const metadata = JSON.parse(payload.view.private_metadata);
	console.log("metadata1", metadata);

	const requestId = metadata.requestId;
	console.log("requestId", requestId);
	const messageTs = metadata.messageTs;
	console.log("messageTs", messageTs);
	// const channelId = metadata.channelId;
	const userId = payload.user.id;
	const userName = payload.user.username || userId;

	// Find the funding request
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, "Une erreur s'est produite");
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, "Demande non trouvée");
	}

	const request = caisse.fundingRequests[requestIndex];

	// Update request status and workflow tracking
	request.status = "Pré-approuvé";
	request.preApprovedBy = userId;
	request.preApprovedAt = new Date();
	request.workflow.stage = "pre_approved";
	request.workflow.history.push({
		stage: "pre_approved",
		timestamp: new Date(),
		actor: userId,
		details: "Demande pré-approuvée par admin",
	});

	await caisse.save();

	// Update admin message
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: messageTs,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Demande de Fonds - Pré-approuvée: ${requestId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				...generateRequestDetailBlocks(request),
				// {
				//   type: "section",
				//   fields: [
				//     {
				//       type: "mrkdwn",
				//       text: `*Montant:*\n${request.amount} ${request.currency}`,
				//     },
				//     { type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Date requise:*\n${
				//         new Date(request.requestedDate).toLocaleString("fr-FR", {
				//           weekday: "long",
				//           year: "numeric",
				//           month: "long",
				//           day: "numeric",
				//         }) || new Date().toISOString()
				//       }`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Demandeur:*\n${
				//         request.submitterName || request.submittedBy
				//       }`,
				//     },
				//     // {
				//     //   type: "mrkdwn",
				//     //   text: `*Pré-approuvé par:* <@${userId}> le ${new Date().toLocaleString(
				//     //     "fr-FR",
				//     //     {
				//     //       weekday: "long",
				//     //       year: "numeric",
				//     //       month: "long",
				//     //       day: "numeric",
				//     //       hour: "2-digit",
				//     //       minute: "2-digit",
				//     //       timeZoneName: "short",
				//     //     }
				//     //   )}`,
				//     // },
				//   ],
				// },

				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `✅ *Pré-approuvé* par <@${userId}> le ${new Date().toLocaleString(
								"fr-FR",
								{
									weekday: "long",
									year: "numeric",
									month: "long",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
									timeZoneName: "short",
								}
							)} - En attente des détails de la finance `,
						},
					],
				},
			],
			text: `Demande de fonds ${requestId} pré-approuvée - En attente des détails de la finance`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify finance team to fill details form
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Demande de Fonds - ${requestId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				...generateRequestDetailBlocks(request),

				// {
				//   type: "section",
				//   fields: [
				//     {
				//       type: "mrkdwn",
				//       text: `*Montant:*\n${request.amount} ${request.currency}`,
				//     },
				//     { type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Date requise:*\n${new Date(
				//         request.requestedDate
				//       ).toLocaleString("fr-FR", {
				//         weekday: "long",
				//         year: "numeric",
				//         month: "long",
				//         day: "numeric",
				//       })}`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Demandeur:*\n${
				//         request.submitterName || request.submittedBy
				//       }`,
				//     },

				//   ],
				// },
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `✅ *Pré-approuvé* par <@${userId}> le ${new Date().toLocaleString(
								"fr-FR",
								{
									weekday: "long",
									year: "numeric",
									month: "long",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
									timeZoneName: "short",
								}
							)} - En attente des détails de la finance `,
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
								text: "Fournir les détails",
								emoji: true,
							},
							style: "primary",
							value: requestId,
							action_id: "fill_funding_details",
						},
					],
				},
			],
			text: `Demande de fonds ${requestId} à traiter - Veuillez fournir les détails de paiement`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify requester of pre-approval
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text:
							":heavy_dollar_sign: ✅ Demande de Fonds ID: " +
							requestId +
							" - Pré-approuvée " +
							` par <@${userName}> le ${new Date().toLocaleDateString()}`,
						emoji: true,
					},
				},
			],
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}
async function handlePreApprovalConfirmation(payload, context) {
	console.log("**2 pre_approval_confirmation_submit");

	const processingMessage = await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		process.env.SLACK_BOT_TOKEN
	);
	console.log("processingMessage", processingMessage);

	// Immediate response to close modal
	const immediateResponse = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		try {
			await handlePreApproval(payload, context);
			console.log("Pre-approval processing completed");
		} catch (error) {
			console.error("Pre-approval processing error:", error);
		}
	});

	return immediateResponse;
}
async function openPreApprovalConfirmationDialog(payload) {
	console.log("** openPreApprovalConfirmationDialog");
	const requestId = payload.actions[0].value;

	try {
		// Find the funding request to show details in confirmation
		const caisse = await Caisse.findOne({
			"fundingRequests.requestId": requestId,
		});
		console.log("requestId1", requestId);
		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return;
		}

		const request = caisse.fundingRequests.find(
			(r) => r.requestId === requestId
		);
		if (!request) {
			console.error(`Request ${requestId} not found`);
			return;
		}

		// Open confirmation modal
		const view = {
			type: "modal",
			callback_id: "pre_approval_confirmation_submit",
			title: { type: "plain_text", text: "Confirmation" },
			submit: { type: "plain_text", text: "Confirmer" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Êtes-vous sûr de vouloir approuver cette demande ?`,
					},
				},
			],
			private_metadata: JSON.stringify({
				requestId,
				action: "accept",
				messageTs: payload.message.ts,
			}),
		};

		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		console.error(`Error opening confirmation dialog: ${error.message}`);
	}
}
async function handleFinalApproval(payload) {
	console.log("** handleFinalApproval");
	// Extract data from the view submission payload
	const viewSubmission = payload.view;
	const metadata = JSON.parse(viewSubmission.private_metadata);
	const requestId = metadata.requestId;
	const userId = payload.user.id;
	// const userName = payload.user.username || userId;
	const messageTs = metadata.messageTs;
	const channelId = metadata.channelId;

	// Get selected payment method
	const paymentMethod =
		viewSubmission.state.values.payment_method.input_payment_method
			.selected_option.value;

	// Get optional payment notes
	const paymentNotes =
		viewSubmission.state.values.payment_notes.input_payment_notes.value || "";

	// Find the funding request
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, "Une erreur s'est produite");
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, "Demande non trouvée");
	}

	const request = caisse.fundingRequests[requestIndex];

	// Update request status
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date();
	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Demande approuvée finalement",
	});

	// Create payment details based on the form submission
	request.paymentDetails = {
		method: paymentMethod,
		sourceAccountText: paymentNotes || "N/A",
	};

	// Update caisse balance for the specific currency
	caisse.balances[request.currency] =
		(caisse.balances[request.currency] || 0) + request.amount;

	// Record transaction
	caisse.transactions.push({
		type: "Funding",
		amount: request.amount,
		currency: request.currency,
		requestId,
		details: `Approuvée par <@${userId}> (${getPaymentMethodText(
			paymentMethod
		)})`,
		timestamp: new Date(),
	});

	await caisse.save();

	// Update admin message
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: channelId,
			ts: messageTs,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: ":heavy_dollar_sign: Demande de Fonds (APPROUVÉE)",
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
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
						{ type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
						{
							type: "mrkdwn",
							text: `*Demandeur:*\n${
								request.submitterName || request.submittedBy
							}`,
						},
						{
							type: "mrkdwn",
							text: `*Méthode:*\n${getPaymentMethodText(paymentMethod)}`,
						},
						{ type: "mrkdwn", text: `*Source:*\n${paymentNotes || "N/A"}` },
						{ type: "mrkdwn", text: `*Approuvée par:*\n<@${userId}>` },
						{
							type: "mrkdwn",
							text: `*Date d'approbation:*\n${new Date().toLocaleDateString()}`,
						},
					],
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `✅ *APPROUVÉ* - Caisse rechargée de ${request.amount} ${
								request.currency
							}. Nouveau solde: ${caisse.balances[request.currency]} ${
								request.currency
							}`,
						},
					],
				},
			],
			text: `Demande de fonds ${requestId} APPROUVÉE - Caisse rechargée`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
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
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			text: `✅ Demande de fonds ${requestId} APPROUVÉE par <@${userId}>. La caisse a été rechargée de ${
				request.amount
			} ${request.currency}. Nouveau solde: ${
				caisse.balances[request.currency]
			} ${request.currency}`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify the requester
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			text: `✅ Votre demande de fonds (ID: ${requestId}) a été APPROUVÉE! Le montant de ${
				request.amount
			} ${request.currency} a été disponibilisé via ${getPaymentMethodText(
				paymentMethod
			)}.`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}
async function handleFinalApprovalConfirmation(payload, context) {
	console.log("**5 final_approval_confirmation_submit");

	// Immediate response
	const immediateResponse = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		try {
			await processFinalApproval(payload, context);
		} catch (error) {
			console.error("Final approval processing error:", error);
		}
	});

	return immediateResponse;
}
async function openFinalApprovalConfirmationDialog(payload) {
	console.log("** openFinalApprovalConfirmationDialog");
	const action = payload.actions[0];
	const requestId = action.value;

	try {
		// Find the funding request to show details in confirmation
		const caisse = await Caisse.findOne({
			"fundingRequests.requestId": requestId,
		});

		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return;
		}

		const request = caisse.fundingRequests.find(
			(r) => r.requestId === requestId
		);
		if (!request) {
			console.error(`Request ${requestId} not found`);
			return;
		}

		// Get payment method text for display
		// const paymentMethodText =
		// 	request.disbursementType === "Espèces" ? "Espèces" : "Chèque";
		let paymentDetailsText = "";

		if (
			request.disbursementType === "Chèque" &&
			request.paymentDetails?.cheque
		) {
			const cheque = request.paymentDetails.cheque;
			// eslint-disable-next-line no-unused-vars
			paymentDetailsText = `*Numéro:* ${cheque.number}\n*Banque:* ${cheque.bank}\n*Date:* ${cheque.date}\n*Ordre:* ${cheque.order}`;
		}

		// Open confirmation modal
		const view = {
			type: "modal",
			callback_id: "final_approval_confirmation_submit",
			title: { type: "plain_text", text: "Confirmation" },
			submit: { type: "plain_text", text: "Confirmer" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Êtes-vous sûr de vouloir approuver cette demande ?`,
					},
				},
			],
			private_metadata: JSON.stringify({
				requestId: requestId,
				messageTs: payload.message.ts,
				channelId: payload.channel.id,
			}),
		};

		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		console.error(
			`Error opening final approval confirmation dialog: ${error.message}`
		);
	}
}
async function processFinalApproval(payload) {
	const metadata = JSON.parse(payload.view.private_metadata);
	const { requestId } = metadata;
	const userId = payload.user.username;

	// Find and update caisse
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});

	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return;
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);

	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return;
	}

	const request = caisse.fundingRequests[requestIndex];

	// Update request status
	await updateRequestStatus(request, userId);

	// Update caisse balance and transactions
	await updateCaisseBalance(caisse, request, requestId, userId);

	// Sync to Excel
	await syncCaisseToExcel(caisse, requestId);

	// Send notifications ????
	// await sendApprovalNotifications(request, userId, messageTs, caisse);
}
async function handleApproveFunding(payload, action, context) {
	const messageTs = payload.message?.ts;
	const requestId = action.value;

	context.log(`Processing approve_funding for request: ${requestId}`);

	await generateFundingApprovalPaymentModal(
		context,
		payload.trigger_id,
		messageTs,
		requestId
	);

	return createSlackResponse(200, "");
}
async function handleRejectFundingSubmission(params) {
	const { payload, userName, slackToken } = params;

	const response = createImmediateResponse();

	setImmediate(async () => {
		const privateMetadata = JSON.parse(payload.view.private_metadata);
		const requestId = privateMetadata.requestId;

		const newPrivateMetadata = JSON.stringify({
			channelId: privateMetadata.channelId || payload.channel?.id || "unknown",
			formData: {
				...(privateMetadata.formData || {}),
				...payload.view.state.values,
			},
			originalViewId: privateMetadata.originalViewId || payload.view.id,
		});

		const metadata = JSON.parse(newPrivateMetadata);
		const rejectionReason =
			metadata.formData.rejection_reason_block.rejection_reason_input.value;

		await processFundingApproval(
			requestId,
			"reject",
			rejectionReason,
			privateMetadata.message_ts,
			privateMetadata.channel_id,
			userName
		);

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: payload.user.id,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: ❌ Demande de Fonds ID: ${requestId} - Rejetée par <@${userName}> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
							emoji: true,
						},
					},
				],
			},
			slackToken
		);
	});

	return response;
}
async function processFundingApproval(
	requestId,
	action,
	rejectionReason = null,
	messageTs = null,
	channelId = null,
	userId,
	chequeDetails = null
) {
	console.log("** processFundingApproval");
	console.log("requestId1", requestId);

	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) throw new Error("Caisse non trouvée");

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) throw new Error("Demande non trouvée");

	const request = caisse.fundingRequests[requestIndex];
	console.log("rejectionReason", rejectionReason);
	if (action === "reject") {
		request.status = "Rejeté";
		request.approvedBy = userId;
		request.approvedAt = new Date();
		//!$$$$$$$$$$$$$$
		request.rejectionReason = rejectionReason;
	} else {
		request.status = "Validé";
		request.approvedBy = userId;
		request.approvedAt = new Date();
		request.disbursementType = action === "approve_cash" ? "Espèces" : "Chèque";

		if (chequeDetails) {
			request.chequeDetails =
				typeof chequeDetails === "string"
					? chequeDetails
					: JSON.stringify(chequeDetails);
		}

		// Update balance for the specific currency
		caisse.balances[request.currency] += request.amount;
		caisse.transactions.push({
			type: "Funding",
			amount: request.amount,
			currency: request.currency,
			requestId,
			details: `Approuvée par <@${userId}> (${request.disbursementType})`,
			timestamp: new Date(),
		});
	}

	await caisse.save();
	// Generate funding request blocks
	const fundingRequestBlocks = generateFundingRequestBlocks({
		requestId,
		amount: request.amount,
		currency: request.currency,
		reason: request.reason,
		requestedDate: request.requestedDate,
		userId,
		submittedAt: new Date(),
	});
	// Update the admin channel message if messageTs and channelId are provided
	if (messageTs && channelId) {
		try {
			// Prepare message update data based on action
			const updateData = {
				channel: channelId,
				ts: messageTs,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de Fonds `,
							emoji: true,
						},
					},
					...fundingRequestBlocks,

					{
						type: "section",
						text: {
							type: "mrkdwn",
							text:
								action === "reject"
									? `❌ *REJETÉE* par <@${userId}> le ${new Date().toLocaleString(
											"fr-FR"
									  )}\n*  Raison:* ${rejectionReason || "Non spécifiée"}`
									: `✅ *APPROUVÉE* par <@${userId}> le ${new Date().toLocaleString(
											"fr-FR"
									  )}\n*Type:* ${request.disbursementType}`,
						},
					},
				],
			};

			// Update the message
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.update",
				updateData,
				process.env.SLACK_BOT_TOKEN
			);

			console.log(`Admin message updated for request ${requestId}`);
		} catch (error) {
			console.error(`Failed to update admin message: ${error.message}`);
		}
	}
	// Sync to Excel to update the existing row
	try {
		await syncCaisseToExcel(caisse, requestId);
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
}
module.exports = {
	handlePreApproval,
	handlePreApprovalConfirmation,
	openPreApprovalConfirmationDialog,
	handleFinalApproval,
	handleFinalApprovalConfirmation,
	openFinalApprovalConfirmationDialog,
	processFinalApproval,
	handleApproveFunding,
	handleRejectFundingSubmission,
	processFundingApproval,
};
