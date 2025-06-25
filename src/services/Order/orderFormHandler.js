const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { createImmediateResponse } = require("../../Handlers/Utils");
const PaymentRequest = require("../../database/dbModels/PaymentRequest");
const Order = require("../../database/dbModels/Order");
const { fetchEntity } = require("../../database/databaseUtils");
const { generateOrderForm } = require("./blockBuilders");
const {
	notifyAdmin,
	notifyUser,
	updateExistingOrderMessages,
	notifyRequesterWithReason,
	updateSlackMessageWithReason,
	updateSlackMessageWithReason1,
} = require("./orderNotificationService");
const { getFromStorage, getChannelName } = require("./orderHelpers");
const { handleOrderStatus } = require("./orderInteractionHandler");
const {
	performErrorChecking,
	validateOrderDate,
} = require("./orderValidationService");
const { executeOrderDeletion, createAndSaveOrder } = require("./orderService");
const { handleProformas } = require("../proformaService");

async function handleOrderFormSubmission(params) {
	console.log("** handleOrderFormSubmission");
	const {
		payload,
		context,
		formData,
		userId,
		userName,
		channelId,
		existingMetadata,
		slackToken,
	} = params;
	console.log("payload&&&&&&&&&&&&", payload);
	console.log("formData&&&&&&&&&&&&", channelId);
	const response = createImmediateResponse();

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: channelId,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		slackToken
	);

	setImmediate(async () => {
		try {
			// Validate date
			const validationResult = await validateOrderDate(
				formData,
				channelId,
				slackToken,
				context
			);
			if (!validationResult.isValid) {
				return validationResult.response;
			}

			// Extract and validate articles
			const { articles, quantityErrors } = extractArticles(formData);
			if (Object.keys(quantityErrors).length > 0) {
				return { response_action: "errors", errors: quantityErrors };
			}

			// AI-based error checking
			const errorCheckResult = await performErrorChecking(
				formData,
				userId,
				payload,
				existingMetadata,
				context
			);
			if (errorCheckResult.hasErrors) {
				return errorCheckResult.response;
			}

			// Handle proformas
			const proformaResult = await handleProformas(
				formData,
				existingMetadata,
				userId,
				context
			);
			if (!proformaResult.isValid) {
				return { response_action: "clear" };
			}

			// Process order (create or update)
			await processOrder(
				payload,
				formData,
				articles,
				proformaResult.proformas,
				existingMetadata,
				userId,
				userName,
				channelId,
				context,
				slackToken
			);

			return { response_action: "clear" };
		} catch (error) {
			context.log(
				`Background processing error: ${error.message}\nStack: ${error.stack}`
			);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.user.id,
					text: `❌ Erreur lors du traitement. Veuillez contacter le support.`,
				},
				slackToken
			);
		}
	});

	return response;
}
async function processOrder(
	payload,
	formData,
	articles,
	proformas,
	existingMetadata,
	userId,
	userName,
	channelId,
	context,
	slackToken
) {
	if (existingMetadata.orderId) {
		// Update existing order
		const order = await Order.findOneAndUpdate(
			{ id_commande: existingMetadata.orderId },
			{
				titre: formData.request_title.input_request_title.value,
				equipe: formData.equipe_selection.select_equipe.selected_option.value,
				date_requete: formData.request_date.input_request_date.selected_date,
				articles,
				proformas,
				date: new Date(),
			},
			{ new: true }
		);

		await updateExistingOrderMessages(
			order,
			existingMetadata,
			channelId,
			userId,
			context,
			slackToken
		);
	} else {
		// Create new order
		const channelName = await getChannelName(channelId, context);
		context.log("channelName&&&&&&&", channelName);
		context.log("channelName", channelName);

		const newOrder = await createAndSaveOrder(
			userId,
			userName,
			channelName,
			channelId,
			formData,
			articles,
			existingMetadata.date_requete,
			proformas,
			context
		);

		await Promise.all([
			notifyAdmin(newOrder, context),
			notifyUser(newOrder, userId, context),
			// updateView(payload.view.id),
		]);
	}
}
// // Add this function to your existing code
// async function handleDeleteOrder(payload, context) {
// 	console.log("** handleDeleteOrder");
// 	try {
// 		context.log("Starting handleDeleteOrder function");

// 		// Extract the proforma index from the value
// 		const valueString = payload.actions[0].value;
// 		const proformaIndex = parseInt(valueString.split("_")[1]);

// 		// Get message info to help identify related data
// 		const messageTs = payload.container.message_ts;
// 		const channelId = payload.channel.id;

// 		// First, try to show a confirmation dialog
// 		try {
// 			context.log("Opening confirmation dialog");
// 			const dialogResponse = await postSlackMessageWithRetry(
// 				"https://slack.com/api/views.open",
// 				{
// 					trigger_id: payload.trigger_id,
// 					view: {
// 						type: "modal",
// 						callback_id: "delete_order_confirmation",
// 						title: {
// 							type: "plain_text",
// 							text: "Confirmation",
// 						},
// 						submit: {
// 							type: "plain_text",
// 							text: "Supprimer",
// 						},
// 						close: {
// 							type: "plain_text",
// 							text: "Annuler",
// 						},
// 						private_metadata: JSON.stringify({
// 							proformaIndex,
// 							messageTs,
// 							channelId,
// 						}),
// 						blocks: [
// 							{
// 								type: "section",
// 								text: {
// 									type: "mrkdwn",
// 									text: `:warning: *Êtes-vous sûr de vouloir supprimer cette commande ?*\n\nCette action est irréversible.`,
// 								},
// 							},
// 							{
// 								type: "input",
// 								block_id: "delete_reason_block",
// 								optional: true,
// 								label: {
// 									type: "plain_text",
// 									text: "Raison de la suppression",
// 								},
// 								element: {
// 									type: "plain_text_input",
// 									action_id: "delete_reason_input",
// 								},
// 							},
// 						],
// 					},
// 				},
// 				process.env.SLACK_BOT_TOKEN
// 			);

// 			if (!dialogResponse.ok) {
// 				context.log(`Error opening modal: ${dialogResponse.error}`);
// 				throw new Error(
// 					`Unable to open confirmation dialog: ${dialogResponse.error}`
// 				);
// 			}

// 			// Return empty response as the modal is now handling the interaction
// 			return createSlackResponse(200);
// 		} catch (dialogError) {
// 			// If modal fails, fall back to ephemeral message with buttons
// 			context.log(`Dialog error: ${dialogError.message}, using fallback`);

// 			return createSlackResponse(200, {
// 				response_type: "ephemeral",
// 				text: "Voulez-vous vraiment supprimer cette commande ?",
// 				blocks: [
// 					{
// 						type: "section",
// 						text: {
// 							type: "mrkdwn",
// 							text: `:warning: *Confirmation de suppression*\n\nÊtes-vous sûr de vouloir supprimer cette commande ?`,
// 						},
// 					},
// 					{
// 						type: "actions",
// 						elements: [
// 							{
// 								type: "button",
// 								text: {
// 									type: "plain_text",
// 									text: "Oui, supprimer",
// 									emoji: true,
// 								},
// 								style: "danger",
// 								value: JSON.stringify({ proformaIndex, messageTs, channelId }),
// 								action_id: "delete_order_confirmed",
// 							},
// 							{
// 								type: "button",
// 								text: {
// 									type: "plain_text",
// 									text: "Annuler",
// 									emoji: true,
// 								},
// 								value: "cancel",
// 								action_id: "delete_order_canceled",
// 							},
// 						],
// 					},
// 				],
// 			});
// 		}
// 	} catch (error) {
// 		context.log(`Error in handleDeleteOrder: ${error.message}`, error.stack);
// 		return createSlackResponse(200, {
// 			response_type: "ephemeral",
// 			text: `❌ Erreur: ${error.message}`,
// 		});
// 	}
// }
async function handleDeleteOrder(text, requestData, isAdmin, context) {
	const { userId, channelId, triggerId } = requestData;
	const orderId = text.trim().split(" ")[1];

	if (!orderId) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "❌ Usage: /order delete [order_id]\nExemple: /order delete CMD/2025/03/0001",
		});
	}

	const existingOrder = await Order.findOne({ id_commande: orderId });

	if (!existingOrder) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Commande ${orderId} non trouvée`,
		});
	}

	if (existingOrder.deleted === true) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: channelId,
				text: `⚠️ La commande ${orderId} a déjà été supprimée.`,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `⚠️ La commande ${orderId} a déjà été supprimée.`,
						},
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200);
	}

	if (!isAdmin) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Seuls les administrateurs peuvent supprimer des commandes.",
		});
	}

	try {
		if (!triggerId) {
			throw new Error("Trigger ID is required for opening the dialog");
		}

		const dialogResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{
				trigger_id: triggerId,
				view: {
					type: "modal",
					callback_id: "delete_order_confirmation",
					title: {
						type: "plain_text",
						text: "Suppression de commande",
						emoji: true,
					},
					submit: {
						type: "plain_text",
						text: "Supprimer",
						emoji: true,
					},
					close: {
						type: "plain_text",
						text: "Annuler",
						emoji: true,
					},
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `:warning: *Êtes-vous sûr de vouloir supprimer la commande ${orderId} ?*\n\nCette action est irréversible.`,
							},
						},
						{
							type: "input",
							block_id: "delete_reason_block",
							label: {
								type: "plain_text",
								text: "Raison de la suppression",
								emoji: true,
							},
							element: {
								type: "plain_text_input",
								action_id: "delete_reason_input",
								multiline: true,
								placeholder: {
									type: "plain_text",
									text: "Entrez la raison de la suppression (optionnel)",
									emoji: true,
								},
							},
						},
					],
					private_metadata: JSON.stringify({
						orderId: orderId,
						channelId: channelId,
					}),
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		if (!dialogResponse.ok) {
			throw new Error(
				`Unable to open confirmation dialog: ${dialogResponse.error}`
			);
		}

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: channelId,
				text: `:hourglass: *Demande de suppression en cours*\nLa commande ${orderId} est en cours de suppression par <@${userId}>.`,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `:hourglass: *Demande de suppression en cours*\nLa commande ${orderId} est en cours de suppression par <@${userId}>.`,
						},
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "⌛ Ouverture de la confirmation de suppression...",
		});
	} catch (error) {
		context.log(`Error in delete command: ${error.message}`);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: ${error.message}`,
		});
	}
}
// Handle cancellation
async function handleDeleteOrderCanceled() {
	console.log("** handleDeleteOrderCanceled");
	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "Suppression annulée.",
	});
}
async function ReturnToForm(payload, context) {
	try {
		// Use payload.actions[0].value instead of payload.value
		const { formDataKey } = JSON.parse(payload.actions[0].value);
		console.log("formDataKey", formDataKey);
		const formData = await getFromStorage(formDataKey);
		if (!formData) {
			context.log(`Form data not found for key: ${formDataKey}`);
			return await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.user.id, // Fallback to team_id if channelId is missing
					user: payload.user.id,
					text: "🛑 Les données du formulaire ont expiré ou sont introuvables. Veuillez recommencer.",
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		// Log the button value length (for debugging, optional)
		const buttonValue = payload.actions[0].value;
		context.log(`Button value length: ${buttonValue.length}`);
		if (buttonValue.length > 2000) {
			throw new Error("Button value exceeds 2000 characters");
		}

		// Safely parse private_metadata with a fallback
		let parsedMetadata;
		try {
			parsedMetadata = payload.view.private_metadata
				? JSON.parse(payload.view.private_metadata)
				: {};
		} catch (parseError) {
			context.log(`Failed to parse private_metadata: ${parseError.message}`);
			parsedMetadata = {};
		}

		// Use parsedMetadata safely
		const safeFormData = formData || {}; // Use retrieved formData instead of metadata
		const originalViewId = parsedMetadata.viewId || payload.view.root_view_id;

		const view = await generateOrderForm([], {}, safeFormData); // Pass the retrieved formData
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.update",
			{
				view_id: originalViewId, // Use the original view ID
				view: {
					...view,
					private_metadata: JSON.stringify({
						...parsedMetadata,
						formDataKey: formDataKey, // Store the key for future reference
					}),
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`Return to form response: ${JSON.stringify(response.data)}`);
		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}
	} catch (error) {
		context.log(
			`❌ Error in return_to_form: ${error.message}\nStack: ${error.stack}`
		);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.user.id, // Fallback to team_id if channelId is missing
				user: payload.user.id,
				text: `🛑 Échec du rechargement du formulaire: ${error.message}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}

async function handleOrderAcceptReject(payload, action, context) {
	console.log("** handleOrderAcceptReject");

	const entityId1 = action.value;

	console.log("paymentId", entityId1);
	console.log("action&", action);

	const entity1 = await fetchEntity(entityId1, context);
	if (!entity1) {
		context.log(`Entity ${entityId1} not found`);
		return {
			response_action: "errors",
			errors: {
				_error: `Entity ${entityId1} not found`,
			},
		};
	}

	// Check order status
	const status = entity1.statut;
	console.log("status1", status);
	// Check if the order has already been approved once
	if (entity1.isApprovedOnce) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id,
				text: `❌ Cet demande a déjà été ${status}e.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		return { response_action: "clear" };
	}

	return await handleOrderStatus(payload, action, context);
}

async function handleDeleteOrderSubmission(params) {
	const { payload, context, slackToken } = params;

	const response = createImmediateResponse();

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		slackToken
	);

	setImmediate(async () => {
		const metadata = JSON.parse(payload.view.private_metadata);
		const values = payload.view.state.values;

		let reason = null;
		if (values.delete_reason_block?.delete_reason_input?.value) {
			reason = values.delete_reason_block.delete_reason_input.value;
		}

		const result = await executeOrderDeletion(
			payload,
			metadata,
			reason,
			context
		);

		if (!result.success) {
			return createSlackResponse(200, {
				response_action: "errors",
				errors: {
					delete_reason_block: result.message,
				},
			});
		}
	});

	return response;
}
// Handle modal submission with rejection reason
async function handleRejectionReasonSubmission(payload, context) {
	console.log("** handleRejectionReasonSubmission");
	const response = createImmediateResponse();


	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		process.env.SLACK_BOT_TOKEN
	);

	setImmediate(async () => {
		try {
			const { entityId, channel_id, message_ts } = JSON.parse(
				payload.view.private_metadata
			);
			console.log("payload5", payload);
			console.log("message_ts", message_ts);

			const rejectionReason =
				payload.view.state.values.rejection_reason_block.rejection_reason_input
					.value;
			if (entityId.startsWith("CMD/")) {
				const order = await Order.findOne({ id_commande: entityId });
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: order.demandeurId,
						blocks: [
							{
								type: "header",
								text: {
									type: "plain_text",
									text:
										":package:  ❌ Commande: " +
										entityId +
										" - Rejetée" +
										` par <@${
											payload.user.username
										}> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
									emoji: true,
								},
							},
						],
					},
					process.env.SLACK_BOT_TOKEN
				);
				// Update order with rejection status and reason
				const updatedOrder = await Order.findOneAndUpdate(
					{ id_commande: entityId },
					{
						$set: {
							statut: "Rejeté",
							rejection_reason: rejectionReason,
							autorisation_admin: false,
						},
					},
					{ new: true }
				);

				if (!updatedOrder) {
					context.log("Commande non trouvée:", entityId);
					return createSlackResponse(404, "Commande non trouvée");
				}

				// Update the original message
				await updateSlackMessageWithReason(
					payload.user.username,
					channel_id,
					message_ts,
					entityId,
					"Rejeté",
					rejectionReason,
					updatedOrder
				);
				context.log("Message Slack mis à jour avec succès");

				// Notify the requester with rejection reason
				await notifyRequesterWithReason(updatedOrder, rejectionReason);

				return { response_action: "clear" };
			}
			// For payment requests (PAY/xxx)
			else if (entityId.startsWith("PAY/")) {
				await PaymentRequest.findOne({ id_paiement: entityId });
				// Update order with rejection status and reason
				const updatedPAY = await PaymentRequest.findOneAndUpdate(
					{ id_paiement: entityId },
					{
						$set: {
							statut: "Rejeté",
							rejectedById: payload.user.id,
							rejectedByName: payload.user.username,
							rejection_reason: rejectionReason,
							autorisation_admin: false,
						},
					},
					{ new: true }
				);

				if (!updatedPAY) {
					context.log("Commande non trouvée:", entityId);
					return createSlackResponse(404, "Commande non trouvée");
				}

				// Update the original message
				await updateSlackMessageWithReason1(
					payload.user.username,
					channel_id,
					message_ts,
					entityId,
					"Rejeté",
					rejectionReason,
					updatedPAY
				);
				context.log("Message Slack mis à jour avec succès");

				// Notify the requester with rejection reason
				await notifyRequesterWithReason(updatedPAY, rejectionReason);

				return { response_action: "clear" };
			}
			// Invalid entity ID format
			else {
				context.log(`Invalid entity ID format: ${entityId}`);
				return null;
			}
		} catch (error) {
			context.log(
				"Erreur lors de la mise à jour du message Slack:",
				error.message
			);

			console.error("Error handling rejection reason submission:", error);
			return createSlackResponse(500, "Error handling rejection");
		}
	});
	return response;
}
// Data Extraction
function extractArticles(formData) {
	console.log("** extractArticles");
	const articles = [];
	const quantityErrors = {};
	let articleIndex = 1;

	while (true) {
		const quantityNumberBlock =
			formData[`quantity_number_${articleIndex}`]?.[
				`input_quantity_${articleIndex}`
			];
		const quantityUnitBlock =
			formData[`quantity_unit_${articleIndex}`]?.[
				`select_unit_${articleIndex}`
			];
		if (!quantityNumberBlock || !quantityUnitBlock) break;

		const quantity = Number(quantityNumberBlock.value) || 0;
		const unit = quantityUnitBlock.selected_option?.value || "piece";
		const designation =
			formData[`designation_${articleIndex}`]?.[
				`input_designation_${articleIndex}`
			]?.value || "";

		articles.push({
			quantity: quantity,
			unit: unit,
			designation: String(designation),
		});

		if (!Number.isInteger(quantity) || quantity <= 0) {
			quantityErrors[`quantity_number_${articleIndex}`] =
				"La quantité doit être un nombre entier positif.";
		}
		articleIndex++;
	}
	return { articles, quantityErrors };
}
module.exports = {
	handleOrderFormSubmission,
	handleDeleteOrder,
	handleDeleteOrderCanceled,
	handleDeleteOrderSubmission,
	handleOrderAcceptReject,
	handleRejectionReasonSubmission,
	ReturnToForm,
	extractArticles,
};
