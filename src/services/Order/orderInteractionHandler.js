const Caisse = require("../../database/dbModels/Caisse");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { syncCaisseToExcel } = require("../caisse/excelSyncService");
const axios = require("axios");
const { handleRejectionReasonSubmission } = require("./orderFormHandler");
const {
	handlePaymentModificationSubmission,
} = require("../Payment/paymentProcessingService");
const Order = require("../../database/dbModels/Order");
const { updateSlackMessage1 } = require("./orderNotificationService");
const {
	generateOrderForm,
	generateProformaBlocks,
	generateArticleBlocks,
} = require("./blockBuilders");
const { notifyTeams } = require("../Notifications/Proforma");
const { executeOrderDeletion } = require("./orderService");

// Order Status Management
async function handleOrderStatus(payload, action, context) {
	console.log("** handleOrderStatus");
	console.log("payload", payload);
	console.log("action", action);

	let paymentId;
	// Handle funds received confirmation
	if (action.action_id === "confirm_funds_received") {
		const requestId = action.value;
		const caisse = await Caisse.findOne({
			"fundingRequests.requestId": requestId,
		});

		if (!caisse) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: "Erreur: Caisse non trouvée",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}

		const requestIndex = caisse.fundingRequests.findIndex(
			(r) => r.requestId === requestId
		);
		if (requestIndex === -1) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: "Erreur: Demande non trouvée",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}

		caisse.fundingRequests[requestIndex].fundsReceived = true;

		caisse.fundingRequests[requestIndex].receivedBy = payload.user.id;

		caisse.fundingRequests[requestIndex].receivedAt = new Date();

		await caisse.save();
		await syncCaisseToExcel(caisse);

		// Update the message to show confirmation
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: payload.channel.id,
				ts: payload.message.ts,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `✅ Réception des fonds confirmée pour la demande *${requestId}*`,
						},
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `Confirmé par <@${
									payload.user.id
								}> le ${new Date().toLocaleDateString()}`,
							},
						],
					},
				],
				text: `Réception des fonds confirmée pour ${requestId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Notify admin
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `✅ <@${payload.user.id}> a confirmé la réception des fonds pour la demande ${requestId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	}
	// If it's a rejection, open a modal to collect rejection reason instead of immediate update
	if (action.action_id === "reject_order") {
		paymentId = action.value;
		console.log("Rejecting order", paymentId);
		//!********************************
		// return openRejectionReasonModal(payload, paymentId);
	} else if (action === "accept") {
		console.log("accept order", action);
		const metadata = JSON.parse(payload.view.private_metadata); // Parse the metadata
		paymentId = metadata.paymentId;
		console.log("orderId", paymentId);
	}
	if (
		payload.type === "view_submission" &&
		payload.view.callback_id === "rejection_reason_modal"
	) {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			return await handleRejectionReasonSubmission(payload, context);
		});

		return context.res;
	}
	if (
		payload.type === "view_submission" &&
		payload.view.callback_id === "payment_modification_modal"
	) {
		console.log("3333");

		// Handle the form submission
		await handlePaymentModificationSubmission(payload, context);

		// Return empty 200 response to close the modal
		context.res = {
			status: 200,
			body: "",
		};
	}
	// For acceptance, proceed as before
	const updatedStatus = "Validé";

	const validatedBy = payload.user.username;
	context.log("validatedBy", validatedBy);
	const updatedOrder = await Order.findOneAndUpdate(
		{ id_commande: paymentId },
		{
			$set: {
				statut: updatedStatus,
				autorisation_admin: true,
				validatedBy: validatedBy,
			},
		},
		{ new: true }
	);

	if (!updatedOrder) {
		context.log("Commande non trouvée:", paymentId);
		return createSlackResponse(404, "Commande non trouvée");
	}
	// Update the original Slack message to remove buttons
	await updateSlackMessage1(payload, paymentId, updatedStatus);
	// await notifyRequester(updatedOrder, updatedStatus);
	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `Bonjour <@${updatedOrder.demandeur}>, votre commande *${updatedOrder.id_commande}* est *${updatedStatus}*.`,
			},
		},
		...(updatedOrder.rejection_reason
			? [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Motif du rejet:*\n${updatedOrder.rejection_reason}`,
						},
					},
			  ]
			: []),
	];
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: updatedOrder.demandeur,
			text: `Commande *${updatedOrder.id_commande}* rejetée`,
			blocks,
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
	await notifyTeams(payload, updatedOrder, context);

	return { response_action: "clear" };
}
// Handle the confirmed delete action
async function handleDeleteOrderConfirmed(payload, context) {
	console.log("** handleDeleteOrderConfirmed");
	try {
		const value = payload.actions[0].value;
		let metadata;

		try {
			metadata = JSON.parse(value);
		} catch (parseError) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur: Format de données invalide.",
			});
		}
		console.log("metadata", metadata);
		const result = await executeOrderDeletion(payload, metadata, null, context);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: result.message,
		});
	} catch (error) {
		context.log(
			`Error in handleDeleteOrderConfirmed: ${error.message}`,
			error.stack
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: ${error.message}`,
		});
	}
}
// Dynamic Form Updates
async function handleDynamicFormUpdates(payload, action, context) {
	console.log("** handleDynamicFormUpdates");
	if (!payload.view || !payload.view.blocks) {
		context.log("❌ Payload invalide: view.blocks manquant");
		return createSlackResponse(400, "Payload invalide");
	}
	if (
		payload.actions[0].type === "overflow" &&
		payload.actions[0].selected_option
	) {
		const selectedValue = payload.actions[0].selected_option.value;
		if (selectedValue.startsWith("remove_proforma_")) {
			try {
				console.log("remove_proforma");
				const indexToRemove = parseInt(selectedValue.split("_")[2], 10);
				const metadata = JSON.parse(payload.view.private_metadata);
				let { formData, suggestions, proformas } = metadata;

				// Remove the proforma at the specified index
				proformas = proformas.filter((_, i) => i !== indexToRemove);

				// Regenerate the form view
				const updatedView = await generateOrderForm(
					proformas,
					suggestions,
					formData
				);

				// Update metadata
				metadata.proformas = proformas;
				updatedView.private_metadata = JSON.stringify(metadata);

				// Update the modal
				const response = await postSlackMessageWithRetry(
					"https://slack.com/api/views.update",
					{
						view_id: payload.view.id,
						view: updatedView,
					},
					process.env.SLACK_BOT_TOKEN
				);

				context.log(
					`Remove proforma response: ${JSON.stringify(response.data)}`
				);
				if (!response.data.ok) {
					throw new Error(`Slack API error: ${response.data.error}`);
				}
			} catch (error) {
				context.log(
					`❌ Error in remove_proforma: ${error.message}\nStack: ${error.stack}`
				);

				await axios.post(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: payload.channel?.id || payload.user.id,
						user: payload.user.id,
						text: `🛑 Échec de la suppression du proforma: ${error.message}`,
					},
					{
						headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
					}
				);
			}
		}
	}
	const actionId = action.action_id;
	let updatedBlocks = [...payload.view.blocks];
	if (actionId === "add_article") {
		const newArticleIndex =
			updatedBlocks.filter((b) => b.block_id?.startsWith("article_")).length +
			1;
		const newArticleBlocks = await generateArticleBlocks(newArticleIndex);
		updatedBlocks.splice(-1, 0, ...newArticleBlocks);
	} else if (actionId.startsWith("add_proforma_")) {
		const articleIndex = actionId.split("_").pop();
		const insertIndex = updatedBlocks.findIndex(
			(b) => b.block_id === `add_proforma_${articleIndex}`
		);
		updatedBlocks.splice(
			insertIndex,
			1,
			...generateProformaBlocks(articleIndex)
		);
	} else if (actionId.startsWith("cancel_proforma_")) {
		const articleIndex = actionId.split("_").pop();
		const insertIndex = updatedBlocks.findIndex(
			(b) => b.block_id === `cancel_proforma_${articleIndex}`
		);

		if (insertIndex !== -1) {
			// Add check to ensure block was found
			updatedBlocks.splice(insertIndex, 4, {
				// Change 3 to 4 to match all proforma blocks
				type: "actions",
				block_id: `add_proforma_${articleIndex}`,
				elements: [
					{
						type: "button",
						action_id: `add_proforma_${articleIndex}`,
						text: { type: "plain_text", text: "📎 Ajouter une proforma" },
						value: `add_proforma_${articleIndex}`,
					},
				],
			});
		}
	} else if (actionId.startsWith("remove_article_")) {
		const index = actionId.split("_").pop();
		updatedBlocks = updatedBlocks.filter(
			(block) =>
				!block.block_id?.startsWith(`article_${index}`) &&
				!block.block_id?.startsWith(`quantity_${index}`) &&
				!block.block_id?.startsWith(`input_quantity_${index}`) &&
				!block.block_id?.startsWith(`quantity_unit_${index}`) &&
				!block.block_id?.startsWith(`quantity_number_${index}`) &&
				!block.block_id?.startsWith(`designation_${index}`) &&
				!block.block_id?.startsWith(`add_proforma_${index}`) &&
				!block.block_id?.startsWith(`divider_${index}`)
		);
	}
	const originalPrivateMetadata = payload.view.private_metadata;
	await postSlackMessageWithRetry(
		"https://slack.com/api/views.update",
		{
			view_id: payload.view.id,
			hash: payload.view.hash,
			view: {
				type: "modal",
				callback_id: "order_form_submission",
				title: { type: "plain_text", text: "Nouvelle Commande" },
				submit: { type: "plain_text", text: "Envoyer" },
				close: { type: "plain_text", text: "Annuler" },
				blocks: updatedBlocks,
				private_metadata: originalPrivateMetadata,
			},
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}
async function view_order(payload, action, context) {
	console.log("** view_order");
	const orderId = action.value.split("order_details_")[1];
	context.log(`Fetching details for order ID: ${orderId}`);

	const order = await Order.findOne({ id_commande: orderId });
	if (!order) {
		context.log(`Order ${orderId} not found`);

		return axios.post(payload.response_url, {
			response_type: "ephemeral",
			text: `⚠️ Commande #${orderId} non trouvée.`,
		});
	}

	// Construct the response text in the same style as handleOrderList
	let responseText = `*📦 Commande #${order.id_commande}*\n\n`;

	// Order Header Information
	const headerDetails = [
		`👤 *Demandeur:* <@${order.demandeur}>`,
		`📌 *Titre:* ${order.titre || "Sans titre"}`,
		`#️⃣ *Canal:* ${order.channel || "Non spécifié"}`,
		`👥 *Équipe:* ${order.equipe || "Non spécifié"}`,
		`📅 *Date:* ${order.date.toLocaleString()}`,
		`⚙️ *Statut:* ${order.statut || "Non défini"}`,
		`🔐 *Autorisation Admin:* ${
			order.autorisation_admin ? "✅ Autorisé" : "❌ Non autorisé"
		}`,
	];
	responseText += headerDetails.join("\n") + "\n";

	// Rejection Reason (if applicable)
	if (order.rejection_reason) {
		responseText += `\n🚫 *Raison du Rejet:* ${order.rejection_reason}\n`;
	}

	// Articles Details
	responseText += "\n*📦 Articles Commandés:*\n";
	if (order.articles.length > 0) {
		order.articles.forEach((article, i) => {
			responseText += `  ${i + 1}. ${article.quantity} ${
				article.unit || ""
			} - ${article.designation}\n`;
		});
	} else {
		responseText += "  - Aucun article\n";
	}

	// Proformas
	responseText += "\n*📝 Proformas:*\n";
	if (order.proformas.length > 0) {
		order.proformas.forEach((proforma, i) => {
			responseText += `  ${i + 1}. `;
			responseText += `*Nom:* <${proforma.urls}|${
				proforma.nom || `Proforma ${i + 1}`
			}> `;
			responseText += `| *Montant:* ${proforma.montant} ${proforma.devise} `;
			responseText += `| *fichiers:* ${proforma.file_ids || "N/A"}\n`;
		});
	} else {
		responseText += "  - Aucun\n";
	}

	// Payments
	responseText += "\n*💰 Détails des Paiements:*\n";
	if (order.payments.length > 0) {
		order.payments.forEach((payment, i) => {
			responseText += `  *Paiement ${i + 1}:*\n`;
			responseText += `    • *Mode:* ${payment.paymentMode}\n`;
			responseText += `    • *Titre:* ${payment.paymentTitle}\n`;
			responseText += `    • *Montant:* ${payment.amountPaid}\n`;
			responseText += `    • *Statut:* ${payment.paymentStatus || "Partiel"}\n`;
			responseText += `    • *Date:* ${payment.dateSubmitted.toLocaleString()}\n`;

			// Payment Proof
			if (payment.paymentProofs?.length > 0) {
				responseText += `    • *Preuve:* <${payment.paymentProofs}|Justificatif>\n`;
			} else if (payment.paymentUrl) {
				responseText += `    • *Lien:* <${payment.paymentUrl}|Lien de Paiement>\n`;
			} else {
				responseText += `    • *Preuve:* Aucune\n`;
			}

			// Payment Details
			responseText += "    • *Détails Supplémentaires:*\n";
			if (payment.details && Object.keys(payment.details).length > 0) {
				Object.entries(payment.details).forEach(([key, value]) => {
					responseText += `      - ${key}: ${value}\n`;
				});
			} else {
				responseText += "      - Aucun détail supplémentaire\n";
			}
		});
	} else {
		responseText += "  - Aucun paiement\n";
	}

	// Total Amount Paid
	responseText += `\n*Total Payé:* ${order.amountPaid || 0}€\n`;

	try {
		console.log("payload.channel.id", payload.channel.id);
		console.log("payload.channel.id", payload);
		try {
			console.log("payload.channel.id", payload.channel.id);

			// Post as a new message in the channel (visible to everyone)

			const slackResponse = await axios.post(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.channel.id,
					text: responseText,
					// Optional: make it a thread reply to the original message
					thread_ts: payload.container.message_ts,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);

			context.log(`Slack response: ${JSON.stringify(slackResponse.data)}`);

			if (!slackResponse.data.ok) {
				throw new Error(`Slack API error: ${slackResponse.data.error}`);
			}

			return createSlackResponse(200, "");
		} catch (error) {
			context.log(`Error sending to Slack API: ${error.message}`);
			if (error.response) {
				context.log(
					`Slack error response: ${JSON.stringify(error.response.data)}`
				);
			}

			// Fallback to response_url if channel posting fails
			try {
				await axios.post(payload.response_url, {
					response_type: "ephemeral",
					text: responseText,
				});
			} catch (fallbackError) {
				context.log(`Fallback also failed: ${fallbackError.message}`);
			}

			return createSlackResponse(200, "");
		}
	} catch (error) {
		context.log(`Error sending to Slack API: ${error.message}`);
		if (error.response) {
			context.log(
				`Slack error response: ${JSON.stringify(error.response.data)}`
			);
		}
	}

	return createSlackResponse(200, ""); // Empty response to avoid Slack timeout error
}
async function editOrder(payload, context) {
	try {
		// Get the order ID from the payload
		const orderId = payload.actions[0].value;
		context.log(`Editing order with ID: ${orderId}`);

		// Fetch the order from the database
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order with ID ${orderId} not found`);
		}
		console.log("Order object:", order);

		console.log(`order.status ${order.statut}`);
		if (order.statut == "En attente") {
			// Prepare the form data from the existing order
			const formData = {
				request_title: {
					input_request_title: {
						value: order.titre || "",
					},
				},
				equipe_selection: {
					select_equipe: {
						selected_option: {
							value: order.equipe || "Non spécifié",
							text: {
								type: "plain_text",
								text: order.equipe || "Non spécifié",
							},
						},
					},
				},
				request_date: {
					input_request_date: {
						selected_date: order.date
							? new Date(order.date).toISOString().split("T")[0]
							: new Date().toISOString().split("T")[0],
					},
				},
			};
			console.log("formData:", formData);
			// Add articles data
			if (order.articles && order.articles.length > 0) {
				order.articles.forEach((article, index) => {
					const articleIndex = index + 1;

					// Add designation
					formData[`designation_${articleIndex}`] = {
						[`input_designation_${articleIndex}`]: {
							value: article.designation || "",
						},
					};

					// Add quantity
					formData[`quantity_number_${articleIndex}`] = {
						[`input_quantity_${articleIndex}`]: {
							value: article.quantity ? String(article.quantity) : "0",
						},
					};

					// Add unit - Make sure to include both value and text properties
					const unitValue = article.unit || "piece";
					const unitText = article.unit || "Pièce";

					formData[`quantity_unit_${articleIndex}`] = {
						[`select_unit_${articleIndex}`]: {
							selected_option: {
								value: unitValue,
								text: {
									type: "plain_text",
									text: unitText,
								},
							},
						},
					};
				});
			}

			// Prepare the suggestions object with any proformas
			const suggestions = {
				titre: order.titre || "",
				designations: order.articles?.map((a) => a.designation) || [],
			};

			// Generate the form view with the order data
			const view = await generateOrderForm(
				order.proformas || [],
				suggestions,
				formData
			);

			// Add metadata to track that this is an edit operation
			const metadata = {
				formData: formData,
				originalViewId: payload.trigger_id,
				orderId: orderId,
				isEdit: true,
				proformas: order.proformas || [],
				// Store the original message details
				originalMessage: {
					channel: payload.channel?.id || payload.channel || payload.user.id,
					ts: payload.message?.ts, // Store the timestamp of the original message
				},
			};
			console.log("$ metadata", metadata);
			// Open the modal with the prefilled data
			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						...view,
						private_metadata: JSON.stringify(metadata),
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			context.log(`Edit order form response:`, response);

			// Handle the case where response might be undefined or not have the expected structure
			if (!response) {
				throw new Error("No response received from Slack API");
			}

			// Check if response has the ok property, if not assume success for now
			const isSuccess = response.ok !== undefined ? response.ok : true;

			if (!isSuccess) {
				const errorMessage = response.error || "Unknown Slack API error";
				throw new Error(`Slack API error: ${errorMessage}`);
			}
		} else {
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel?.id || payload.channel || payload.user.id,
					user: payload.user.id,
					//text: `🛑 Échec de l'édition de la commande: ${error.message}`,
					text: `⚠️ Commande ${order.statut}e par l'Administrateur vous ne pouvez pas la modifier`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
		}
	} catch (error) {
		context.log(
			`❌ Error in edit_order: ${error.message}\nStack: ${error.stack}`
		);

		await axios.post(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel?.id || payload.channel || payload.user.id,
				user: payload.user.id,
				text: `🛑 Échec de l'édition de la commande: ${error.message}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);
	}
}
async function OpenForm(payload, context) {
	try {
		const autoSuggestions = [];
		// await require("./aiService").suggestAutoCompletions(
		//   payload.user.id,
		//   context
		// );

		const view = await generateOrderForm([], {
			titre: autoSuggestions.titre,

			equipe: autoSuggestions.equipe,

			quantity: autoSuggestions.quantity,

			unit: autoSuggestions.unit,

			designations: autoSuggestions.designations,
		});

		if (payload.channel && payload.channel.id) {
			view.private_metadata = JSON.stringify({
				channelId: payload.channel.id,
			});
		}

		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`views.open response: ${JSON.stringify(response)}`);

		// Check if response exists before accessing its properties
		if (!response) {
			context.log(`❌ postSlackMessageWithRetry returned undefined response`);
			return {
				statusCode: 500,
				body: JSON.stringify({
					response_type: "ephemeral",
					text: `❌ Erreur: Aucune réponse de l'API Slack`,
				}),
				headers: { "Content-Type": "application/json" },
			};
		}

		// The response structure is directly the Slack API response, not wrapped in .data
		if (!response.ok) {
			context.log(`views.open error: ${response.error}`);
			return {
				statusCode: 200,
				body: JSON.stringify({
					response_type: "ephemeral",
					text: `❌ Erreur: ${response.error}`,
				}),
				headers: { "Content-Type": "application/json" },
			};
		}

		return { statusCode: 200, body: "" };
	} catch (error) {
		context.log(
			`❌ Error opening form: ${error.message}\nStack: ${error.stack}`
		);
		return {
			statusCode: 200,
			body: JSON.stringify({
				response_type: "ephemeral",
				text: `❌ Erreur: Impossible d'ouvrir le formulaire (${error.message})`,
			}),
			headers: { "Content-Type": "application/json" },
		};
	}
}
module.exports = {
	handleOrderStatus,
	handleDeleteOrderConfirmed,
	handleDynamicFormUpdates,
	view_order,
	editOrder,
	OpenForm,
};
